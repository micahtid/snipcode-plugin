/**
 * reconcile/diff.ts: what counts as a real standalone-versus-live divergence.
 *
 * Shared by the closing reconciliation and the probes, which must answer identically or a
 * probe would report a residual the reconciliation refuses to fix. Holds which properties are
 * worth comparing, what counts as equal given float noise, and which direction of a size
 * divergence is a defect.
 */

/**
 * Properties left out of the standalone comparison. A divergence in one of these is benign
 * context rather than a lost style:
 *
 * - Margins position a box against siblings that did not travel. The root's are zeroed
 *   separately, and a descendant's re-derive from the recovered box.
 * - min/max sizes are redundant, since the reconciliation pins the used size directly.
 * - transform and perspective origins resolve from the box, and -webkit-locale never paints.
 * - Transition longhands produce no pixels at rest, so a resting render cannot judge them.
 *   Reclaiming one would collapse a cycled timing sub-list back to a single literal, undoing
 *   the lossless expansion resolve/transition.ts makes for the emitted shorthand.
 *
 * Used size and insets are deliberately NOT here: they are compared everywhere, and
 * shouldReclaim decides direction from the replaced or non-replaced category. Custom
 * properties are handled separately, since they never enumerate. Everything else compares.
 */
const SKIP_PROPS = new Set<string>([
	'min-width', 'min-height', 'max-width', 'max-height',
	'min-inline-size', 'min-block-size', 'max-inline-size', 'max-block-size',
	'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
	'transform-origin', 'perspective-origin', '-webkit-locale',
	'transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay', 'transition-behavior',
]);

/**
 * The used-size longhands, physical and logical, which carry the directional rule in
 * shouldReclaim. A non-replaced box only ever loses a sizing input standalone, so a real
 * defect is a collapse. A replaced box is intrinsic, so either direction is a lost size.
 * Insets have no intrinsic direction and reclaim on any divergence, like paint.
 */
const SIZE_PROPS = new Set<string>(['width', 'height', 'inline-size', 'block-size']);

/**
 * Replaced elements, whose box comes from intrinsic content rather than in-flow layout. An
 * svg with only a viewBox collapses and a raster free-sizes past its old cell, so a
 * divergence either way is wrong and shouldReclaim pins their size symmetrically. svg
 * reports a lowercase tagName where html elements report uppercase, so the test case-folds.
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
 * Whether a standalone-versus-live divergence is a real defect to reclaim, with direction
 * decided by a css distinction rather than a tolerance.
 *
 * - Sub-0.1px float noise reclaims nothing.
 * - A color that is only following `currentColor`, its target equal to the element's own
 *   `color`, is left to keep following. `color` itself reclaims and carries the value down.
 *   Freezing a concrete color here would inherit onto every descendant that sets only its
 *   own color, so a light-labelled button under dark text would paint dark.
 * - A non-replaced used size reclaims only on a confirmed numeric collapse. A box the same
 *   or larger has the room its content needs, and a keyword size like `auto` cannot be shown
 *   to have collapsed at all. That restraint is what keeps a font-grown fallback box from
 *   being clipped back to the live width.
 * - A replaced used size reclaims either way, since its box is intrinsic.
 * - Everything else reclaims on any real divergence.
 */
export function shouldReclaim(prop: string, artifact: string, target: string, replaced: boolean, targetColor: string): boolean {
	if (valuesMatch(artifact, target)) return false;
	// A color that equals the element's own `color` is following currentColor, and `color`
	// reconciles in its own right. See the note above.
	if (prop !== 'color' && target === targetColor) return false;
	if (SIZE_PROPS.has(prop) && !replaced) {
		// A confirmed numeric collapse only. Growth and a non-numeric comparison both stay.
		const a = parseFloat(artifact);
		const t = parseFloat(target);
		return Number.isFinite(a) && Number.isFinite(t) && a < t;
	}
	return true;
}

/**
 * The longhands worth comparing: every enumerable computed longhand minus the skip set. The
 * standalone render is the authority, so the list is deliberately broad rather than a
 * hand-picked "important props" set.
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
 * Whether two computed values are equal up to sub-0.1px float noise: every embedded number is
 * rounded to one decimal before comparing. A px-to-rem-to-px round-trip residual such as
 * 21.0012px against 21.0013px is not a loss, while a dropped declaration falling back to 0 or
 * normal still differs. The threshold is well below one device pixel.
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
