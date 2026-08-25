/**
 * reconcile/match.ts: rebuilding the authored cascade from the captured rules.
 *
 * Runs in reconcile, ahead of bake.ts. For each live element it finds the matching rules with
 * the browser's own element.matches(), orders them by specificity, and merges them into one
 * authored value per property.
 *
 * Deliberately small: no specificity edge cases, no layer expansion, no property tables. The
 * probe in bake.ts validates every decision against the real computed value, so an imperfect
 * cascade here cannot produce a wrong pixel. It can only fall back to computed.
 */
import type { Captured, CssRule } from '../types';
import { subtreeElements } from './tree';

/** One authored declaration with its cascade rank, before merge. */
interface RankedDecl {
	value: string;
	specificity: number;
	important: boolean;
	order: number; // Document order, breaks specificity ties
}

/**
 * Builds the merged authored cascade for every element in the picked subtree.
 *
 * @returns a map from each live element to its winning authored value per property
 */
export function authoredCascade(captured: Captured): Map<Element, Map<string, string>> {
	const rules = [...captured.foundationRules, ...captured.componentRules];
	const result = new Map<Element, Map<string, string>>();

	let order = 0;
	const all = subtreeElements(captured.root);
	for (const el of all) {
		const ranked = new Map<string, RankedDecl>();
		for (const rule of rules) {
			if (!ruleApplies(rule, el)) continue;
			mergeRule(rule, ranked, order++);
		}
		// Inline style attribute wins over any stylesheet rule, equivalent to
		// specificity 1,0,0,0. Fold it in last at the highest rank.
		foldInlineStyle(el, ranked, order++);
		result.set(el, resolveWinners(ranked));
	}
	return result;
}

/**
 * Pairs each live element with its clone counterpart, walking both trees in lockstep and
 * skipping clone-only nodes a feature handler injected, such as a pseudo <style>.
 *
 * Without the skip, index-based pairing drifts the moment a handler mutates clone structure
 * and every later handler silently misaligns.
 *
 * @param clone - the working clone (may carry handler-injected nodes)
 * @returns aligned [original, clone] pairs, root first
 */
export function pairedSubtrees(root: Element, clone: Element): Array<[Element, Element]> {
	const out: Array<[Element, Element]> = [];
	const walk = (o: Element, c: Element): void => {
		out.push([o, c]);
		const oChildren = Array.from(o.children);
		const cChildren = Array.from(c.children).filter((ch) => !isInjected(ch));
		const n = Math.min(oChildren.length, cChildren.length);
		for (let i = 0; i < n; i++) {
			const oc = oChildren[i];
			const cc = cChildren[i];
			if (oc && cc) walk(oc, cc);
		}
	};
	walk(root, clone);
	return out;
}

/**
 * Records one value in the baked map and on the clone's inline style.
 *
 * Every feature handler ends in this pair of writes, so it lives here. setProperty throws for
 * a property this element rejects; the baked-map entry is what the emitters read, so the throw
 * is swallowed rather than losing the value.
 */
export function setBaked(clone: Element, baked: Map<string, string>, prop: string, value: string): void {
	baked.set(prop, value);
	try {
		(clone as HTMLElement).style.setProperty(prop, value);
	} catch {
		// Invalid for this element, so skip it.
	}
}

/** One property a feature handler bakes when its computed value is non-default. */
export interface BakeSpec {
	prop: string;
	isDefault: (value: string) => boolean;
}

/**
 * Bakes a list of computed properties onto every clone, wherever the live value is
 * non-default and the per-element pass has not already baked it.
 *
 * This is the shape the tables, lists, forms, and text handlers all wanted. Keeping the
 * getComputedStyle read here also keeps those leaf handlers free of it.
 *
 * @param captured - bakedStyles + clone mutated in place
 */
export function bakeNonDefaultProps(captured: Captured, specs: BakeSpec[]): void {
	for (const [original, clone] of pairedSubtrees(captured.root, captured.clone)) {
		const computed = getComputedStyle(original);
		const baked = captured.bakedStyles.get(clone) ?? new Map<string, string>();
		for (const { prop, isDefault } of specs) {
			if (baked.has(prop)) continue;
			const value = computed.getPropertyValue(prop);
			if (!value || isDefault(value)) continue;
			setBaked(clone, baked, prop, value);
		}
		if (baked.size > 0) captured.bakedStyles.set(clone, baked);
	}
}

/** What a declaration would fall back to if dropped, plus the element's transform context. */
export interface RedundancyContext {
	/** Fallback for a NON-inherited property: the per-tag ua default, or a pseudo's css
	 * initial. Undefined means no baseline, which keeps the declaration. */
	defaultValue: string | undefined;
	/** Fallback for an INHERITED property: the parent's computed value, or the originating
	 * element's for a pseudo. Undefined means none, which keeps it. */
	inheritedValue: string | undefined;
	/** Whether this property inherits by default. See inheritsProperty. */
	inherits: boolean;
	/** Whether the element establishes a transform (transform/translate/rotate/scale). */
	hasTransform: boolean;
	/** Whether the element establishes perspective. */
	hasPerspective: boolean;
}

/**
 * Pure test for a declaration that can be dropped without changing rendering. Either it has
 * no effect here (an inert transition, an orphan transform-origin), or it restates the value
 * the element falls back to anyway.
 *
 * The match is exact-string against a value the caller resolved from ground truth, so an
 * unrecognized form is kept rather than guessed at. Same stance bake.ts takes, applied to
 * removal instead of baking.
 *
 * @returns true when the declaration is safe to drop
 */
export function isRedundantDecl(prop: string, value: string, ctx: RedundancyContext): boolean {
	const v = value.trim();
	// Custom properties never enumerate in getComputedStyle and carry author intent.
	if (prop.startsWith('--')) return false;
	// An empty value does not serialize anyway. Dropping it means removeProperty, and on a
	// shorthand (the `all` reset above all) that wipes the element's whole inline style.
	if (v === '') return false;
	// A transition acts only on a state change, so a zeroed one is noise at rest. Real
	// durations stay, so a polish-added :hover still animates.
	if (prop === 'transition') return isInertTransition(v);
	if (prop.startsWith('transition-')) return false;
	// The origin properties act only on a box that has a transform or perspective, and their
	// per-element pixel values are not comparable to a probe default anyway.
	if (prop === 'transform-origin') return !ctx.hasTransform;
	if (prop === 'perspective-origin') return !ctx.hasTransform && !ctx.hasPerspective;
	// Layout properties resolve to this element's own pixels, so a probe value is a different
	// element's pixels and equality means nothing. Geometry is baked on purpose.
	if (LAYOUT_PROPS.has(prop)) return false;
	// Inherited: redundant only against the immediate parent, never against initial, so a value
	// that overrides an inheriting ancestor is never mistaken for a default.
	if (ctx.inherits) return ctx.inheritedValue !== undefined && v === ctx.inheritedValue.trim();
	return ctx.defaultValue !== undefined && v === ctx.defaultValue.trim();
}

/** Whether an element or pseudo establishes a transform and a perspective. */
export function transformContext(cs: CSSStyleDeclaration): { hasTransform: boolean; hasPerspective: boolean } {
	const present = (prop: string): boolean => {
		const value = cs.getPropertyValue(prop);
		return value !== '' && value !== 'none';
	};
	const hasTransform = present('transform') || present('translate') || present('rotate') || present('scale');
	return { hasTransform, hasPerspective: present('perspective') };
}

/**
 * Whether a property inherits by default, from the list below rather than a probe. The
 * redundancy test needs the answer independent of any value, which is what a value-based
 * probe cannot give when the value happens to equal the default.
 */
export function inheritsProperty(prop: string): boolean {
	return INHERITED.has(prop);
}

/** True for clone nodes a feature handler injected, with no original counterpart. */
export function isInjected(el: Element): boolean {
	const tag = el.tagName.toLowerCase();
	if (tag === 'style' || tag === 'script') return true;
	// The icons sprite is a hidden zero-size svg we prepended.
	if (tag === 'svg' && el.getAttribute('aria-hidden') === 'true' && /width:\s*0/.test(el.getAttribute('style') ?? '')) {
		return true;
	}
	return false;
}

/**
 * Whether a rule contributes to an element's authored cascade.
 *
 * The browser's own matcher decides, so combinators resolve against the real ancestor chain.
 * Pseudo-element rules are excluded (the pseudo handler owns those), as are rules under an
 * @media that does not currently apply. @container and @supports are not gated here: the bake
 * probe checks every property against the captured computed value, so an over-included rule
 * can only fall back to computed.
 */
function ruleApplies(rule: CssRule, el: Element): boolean {
	if (rule.selector.includes('::')) return false; // Pseudo-element rule
	if (rule.mediaQuery && !mediaApplies(rule.mediaQuery)) return false;
	try {
		// A comma selector matches if any branch matches this element.
		return el.matches(rule.selector);
	} catch {
		// :hover, :has() with unsupported args, or malformed selectors are skipped safely.
		return false;
	}
}

/**
 * Evaluate an @media condition against the live environment. Exported so the states handler
 * gates its rules on the same frozen viewport the resting cascade used.
 */
export function mediaApplies(query: string): boolean {
	try {
		return window.matchMedia(query).matches;
	} catch {
		return true; // Unparseable query, so do not exclude. Probe still guards bake
	}
}

/** Add a rule's declarations to the ranked map, keyed by property. */
function mergeRule(rule: CssRule, ranked: Map<string, RankedDecl>, order: number): void {
	for (const [prop, rawValue] of rule.properties) {
		const important = /!\s*important\s*$/i.test(rawValue);
		const value = rawValue.replace(/!\s*important\s*$/i, '').trim();
		record(ranked, prop, { value, specificity: rule.specificity, important, order });
	}
}

/** Fold the element's inline style attribute in as the highest-specificity source. */
function foldInlineStyle(el: Element, ranked: Map<string, RankedDecl>, order: number): void {
	const style = (el as HTMLElement).style;
	if (!style || style.length === 0) return;
	for (let i = 0; i < style.length; i++) {
		const prop = style.item(i);
		if (!prop) continue;
		record(ranked, prop, {
			value: style.getPropertyValue(prop).trim(),
			// Inline styles outrank all selector specificities.
			specificity: 1_000_000,
			important: style.getPropertyPriority(prop) === 'important',
			order,
		});
	}
}

/** Keep the cascade winner for a property: !important first, then specificity, then order. */
function record(ranked: Map<string, RankedDecl>, prop: string, decl: RankedDecl): void {
	const cur = ranked.get(prop);
	if (!cur || wins(decl, cur)) ranked.set(prop, decl);
}

/** Cascade ordering: !important beats normal, then higher specificity, then later order. */
function wins(a: RankedDecl, b: RankedDecl): boolean {
	if (a.important !== b.important) return a.important;
	if (a.specificity !== b.specificity) return a.specificity > b.specificity;
	return a.order >= b.order;
}

/** Flatten the ranked map to plain prop->value winners. */
function resolveWinners(ranked: Map<string, RankedDecl>): Map<string, string> {
	const out = new Map<string, string>();
	for (const [prop, decl] of ranked) out.set(prop, decl.value);
	return out;
}

/** A transition with no duration (or none/all) animates nothing and is inert at rest. */
function isInertTransition(value: string): boolean {
	return value === 'none' || value === 'all' || /^all 0s\b/.test(value) || /^0s\b/.test(value);
}

/**
 * Properties whose computed value is this element's own resolved pixels, so no probe default
 * compares. bake.ts writes geometry on purpose, so it is kept rather than de-noised.
 */
const LAYOUT_PROPS = new Set([
	'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
	'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
	'top', 'right', 'bottom', 'left',
	'inset-block-start', 'inset-block-end', 'inset-inline-start', 'inset-inline-end',
]);

/**
 * Properties that inherit by default: CSS2.2 plus the text, font, list, and table modules
 * and their webkit aliases. Getting this set wrong drops a value that does not truly fall
 * back, so it follows the documented list rather than judgment.
 */
const INHERITED = new Set([
	// Color and visibility
	'color', 'visibility', 'cursor', 'pointer-events', 'caret-color', 'accent-color', 'color-scheme',
	// Direction and writing mode
	'direction', 'writing-mode', 'text-orientation', 'text-combine-upright', 'unicode-bidi',
	// Fonts
	'font', 'font-family', 'font-size', 'font-size-adjust', 'font-stretch', 'font-style',
	'font-variant', 'font-variant-caps', 'font-variant-ligatures', 'font-variant-numeric',
	'font-variant-east-asian', 'font-variant-alternates', 'font-variant-position',
	'font-weight', 'font-feature-settings', 'font-kerning', 'font-language-override',
	'font-optical-sizing', 'font-synthesis', 'font-variation-settings', 'font-smooth',
	'-webkit-font-smoothing', '-webkit-locale',
	// Text layout
	'letter-spacing', 'line-height', 'text-align', 'text-align-last', 'text-indent',
	'text-justify', 'text-transform', 'text-shadow', 'text-rendering', 'text-underline-position',
	'white-space', 'white-space-collapse', 'word-break', 'word-spacing', 'word-wrap',
	'overflow-wrap', 'line-break', 'hyphens', 'hyphenate-character', 'tab-size',
	'text-size-adjust', '-webkit-text-size-adjust', 'quotes', 'orphans', 'widows',
	// Text emphasis and stroke
	'text-emphasis', 'text-emphasis-color', 'text-emphasis-style', 'text-emphasis-position',
	'-webkit-text-fill-color', '-webkit-text-stroke', '-webkit-text-stroke-color', '-webkit-text-stroke-width',
	'-webkit-tap-highlight-color',
	// Lists
	'list-style', 'list-style-image', 'list-style-position', 'list-style-type',
	// Tables
	'border-collapse', 'border-spacing', 'caption-side', 'empty-cells',
	// Rendering hints
	'image-rendering', 'print-color-adjust', '-webkit-print-color-adjust',
	// Ruby
	'ruby-align', 'ruby-position',
]);
