/**
 * reconcile/diff.ts: what counts as a real standalone-vs-live divergence
 *
 * Pipeline position: reconcile, a helper shared by the closing reconciliation and the probes
 * Reads from Captured: nothing. It compares computed styles the caller hands in.
 * Writes to Captured: nothing.
 *
 * Why this exists: the closing reconciliation and both probes ask the same question of every
 * property, is this divergence a real defect or benign context, and they must answer it
 * identically or the probe would report a residual the reconciliation refuses to fix. The
 * judgment lives here once: which properties are worth comparing at all, what counts as
 * equal given float noise, and which direction of a size divergence is a defect.
 */

/**
 * Properties excluded from the standalone comparison, because a divergence there is
 * benign context rather than a lost style. What remains is precisely the blind spot the
 * directional reclaim closes (used size + insets). Everything skipped here is skipped
 * for a reason the directional rule cannot improve on:
 *
 * - Margins: a margin positions a box against siblings that did not travel with the
 *   snip, so its standalone value is benign. The root's are zeroed separately
 *   (zeroRootMargin), and a descendant's re-derive from the recovered box.
 * - min/max sizes: the reconciliation pins the *used* size directly, as SIZE_PROPS lists,
 *   which already overrides whatever bound produced it, so comparing the bound itself
 *   would be redundant.
 * - Geometry-derived and non-visual props: transform/perspective origins resolve from
 *   the box, and -webkit-locale is an input-method hint with no paint effect.
 * - Transition longhands: a transition describes the motion between two states and produces
 *   no pixels at rest, so the resting-render authority cannot judge it and must not reclaim
 *   it. Reconciling it toward the live value would collapse a cycled timing sub-list back to
 *   its single literal against a multi-entry transition-property, undoing the lossless
 *   expansion resolve/transition.ts makes for the emitted shorthand.
 *
 * Used size (width/height + logical) and insets (top/right/bottom/left + logical) are
 * deliberately NOT here. They are compared for every element and reclaimed through
 * shouldReclaim, which decides direction from the replaced/non-replaced CSS category.
 *
 * Custom properties are handled separately, since they never enumerate in computed style.
 * Everything else is compared. The standalone render is the authority, so any
 * divergence in a paint or box property is a real defect to correct.
 */
const SKIP_PROPS = new Set<string>([
	'min-width', 'min-height', 'max-width', 'max-height',
	'min-inline-size', 'min-block-size', 'max-inline-size', 'max-block-size',
	'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
	'transform-origin', 'perspective-origin', '-webkit-locale',
	'transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay', 'transition-behavior',
]);

/**
 * The used-size longhands, physical and logical. They carry the directional rule in
 * shouldReclaim. A non-replaced box only ever *loses* a sizing input standalone, so a
 * real defect is always a collapse and is reclaimed only when the box shrank. A
 * replaced box is intrinsic, so a divergence either way is a lost size. Insets are
 * deliberately excluded: they have no intrinsic direction, so they reclaim on any
 * divergence, like paint.
 */
const SIZE_PROPS = new Set<string>(['width', 'height', 'inline-size', 'block-size']);

/**
 * Replaced elements, whose box comes from intrinsic content or an explicit dimension
 * rather than in-flow layout. Because their box is intrinsic, a standalone size that
 * diverges in either direction is wrong, since an svg with only a viewBox collapses and a
 * raster image free-sizes past the cell its container imposed, so shouldReclaim pins their
 * size symmetrically. svg reports a lowercase tagName while html elements report uppercase,
 * so the test case-folds.
 */
const REPLACED_TAGS = new Set<string>(['svg', 'img', 'canvas', 'video', 'iframe', 'object', 'embed']);

export function isReplacedElement(el: Element): boolean {
	return REPLACED_TAGS.has(el.tagName.toLowerCase());
}

/** Cap on how many example samples each discrepancy report keeps, to bound its size. */
export const MAX_SAMPLES = 40;
/** How many of the most frequent discrepancy properties a report lists, most-frequent first. */
export const TOP_PROPS = 20;

/**
 * Whether a standalone-vs-live property divergence is a real defect to reclaim (bake the
 * live value), deciding *direction* from a CSS distinction rather than any tolerance.
 *
 * - Within sub-0.1px float noise (valuesMatch) nothing is reclaimed.
 * - A color that merely follows `currentColor`, its target value equal to the element's own
 *   `color`, is never reclaimed as a concrete color. `color` is itself reclaimed when it
 *   diverges and carries the value down, and every `currentColor`-derived property
 *   (-webkit-text-fill-color, caret-color, text-emphasis-color, the border/outline colors,
 *   and their kin) tracks it per element in the standalone render just as it does live.
 *   Baking a concrete color here instead would freeze it onto this element and inherit down,
 *   overriding every descendant that sets only its own `color`, so a light-labelled button
 *   nested under dark text would keep the ancestor's dark fill and paint dark. `color` itself
 *   is never caught by this, so the load-bearing divergence still reclaims.
 * - A non-replaced element's used size is reclaimed only when it is a *confirmed*
 *   collapse, meaning artifact < target with both numeric. A box that lost an externally-imposed
 *   sizing input can only shrink standalone, while a box the same or larger has the room
 *   its content needs and is left alone. This is what protects a font-grown fallback box
 *   from being clipped back to the live width. A comparison that is not numerically
 *   decidable, such as a keyword used size like `auto`, cannot be shown to have collapsed, so
 *   it is left alone too, under that same restraint.
 * - A replaced element's used size is reclaimed in *either* direction: its box is
 *   intrinsic, so free-sizing larger than its display cell is as wrong as collapsing.
 * - Everything else, insets, paint, and box, is reclaimed on any real divergence.
 *
 * @param prop - the computed-style longhand being compared
 * @param artifact - the value the standalone artifact rendered
 * @param target - the live element's value (the authority being reclaimed toward)
 * @param replaced - whether the element is a replaced element (intrinsic box)
 * @param targetColor - the target element's own computed `color`, so a value merely following
 *   `currentColor` is left to track it rather than frozen concrete
 */
export function shouldReclaim(prop: string, artifact: string, target: string, replaced: boolean, targetColor: string): boolean {
	if (valuesMatch(artifact, target)) return false;
	// A color resolving from `currentColor` equals the element's own `color`, which reconciles
	// in its own right. Reclaiming it independently would freeze it and break the cascade for
	// descendants that set only their own color. `color` itself is excluded.
	if (prop !== 'color' && target === targetColor) return false;
	if (SIZE_PROPS.has(prop) && !replaced) {
		// Reclaim only a confirmed numeric collapse. A growth is left alone, since a box the
		// same or larger has the room its content needs, and so is any comparison that
		// is not numerically decidable, such as a keyword used size like `auto`, which cannot
		// be shown to have collapsed. Both fall under the same restraint that keeps a
		// font-grown fallback box from being clipped back to the live width.
		const a = parseFloat(artifact);
		const t = parseFloat(target);
		return Number.isFinite(a) && Number.isFinite(t) && a < t;
	}
	return true;
}

/**
 * The longhand properties worth comparing on an element: every enumerable computed
 * longhand except custom properties, which do not enumerate, and the explicit skip
 * set. The standalone render is the authority, so this list is deliberately broad,
 * never a hand-picked "important props" set. Used size and insets are included for
 * every element, and shouldReclaim then decides which divergences are real defects.
 *
 * @param cs - the element's computed style
 */
export function comparableProps(cs: CSSStyleDeclaration): string[] {
	const out: string[] = [];
	for (let i = 0; i < cs.length; i++) {
		const prop = cs.item(i);
		if (!prop || prop.startsWith('--')) continue;
		if (SKIP_PROPS.has(prop)) continue;
		out.push(prop);
	}
	return out;
}

/** Matches a number, whether int, decimal, or scientific, anywhere in a computed value. */
const NUMBER_TOKEN = /-?\d*\.?\d+(?:e[+-]?\d+)?/gi;

/**
 * Whether two computed values are equal up to sub-0.1px float noise. Identical strings
 * match. Otherwise every embedded number is rounded to one decimal and the normalized
 * forms are compared. A benign length round-trip residual, such as a `px`->`rem`->`px`
 * line-height of 21.0012px vs 21.0013px or a 9999px radius vs 9999.01px, is not counted
 * as a loss, while a real divergence still differs, such as a dropped declaration falling
 * back to 0/normal/currentColor, or a different color. The threshold is well below one
 * device pixel, so nothing visible is masked.
 *
 * @param a - one computed value
 * @param b - the other computed value
 */
function valuesMatch(a: string, b: string): boolean {
	if (a === b) return true;
	return a.replace(NUMBER_TOKEN, roundToTenth) === b.replace(NUMBER_TOKEN, roundToTenth);
}

/** Rounds a matched number token to one decimal place, as a string. */
function roundToTenth(token: string): string {
	const n = parseFloat(token);
	return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : token;
}

/** The 20 most frequent properties from a discrepancy count map, descending. */
export function topN(counts: Map<string, number>): Array<{ prop: string; count: number }> {
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_PROPS).map(([prop, count]) => ({ prop, count }));
}

/** A short positional path from the snip root to `el`, for diagnostic samples. */
export function pathOf(root: Element, el: Element): string {
	const parts: string[] = [];
	let node: Element | null = el;
	while (node && node !== root.parentElement) {
		const parent: Element | null = node.parentElement;
		const idx = parent ? Array.from(parent.children).indexOf(node) : 0;
		parts.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
		if (node === root) break;
		node = parent;
	}
	return parts.join('/');
}
