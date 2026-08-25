/**
 * minimize/normalize.ts: shorthand folding and a readable property order.
 *
 * Runs in minimize, after prune. Reconcile emits longhands in computed-style order, so a box's
 * margins sit apart from its paddings and a border is twelve declarations. This reorders each
 * rule into layout, box, spacing, border, background, type, effects, and lets the cssom fold
 * the now-adjacent families back into shorthands.
 *
 * Reordering distinct properties cannot change the cascade, and folding a full family sets the
 * same values, so it is render-neutral by construction. The oracle confirms it anyway, and a
 * failure ships the pruned css untouched.
 *
 * A second pass drops each longhand a preceding shorthand already sets to that value, which is
 * render-neutral by definition. It needs no oracle, so it runs on the withheld rules too.
 */
import type { Captured } from '../types';
import { withOracle } from './oracle';
import { parseSegments, inScopeRule, serializeRules } from './declarations';
import { LOGICAL_TO_PHYSICAL } from './logical';

/**
 * Property groups in the order a human writes them, each entry a name prefix. A declaration's
 * rank is the first prefix it starts with, and anything unmatched sorts to the end, so this is
 * a soft grouping rather than a per-property table. A more specific prefix precedes the general
 * one it extends, so border-radius groups ahead of border. Same-rank declarations keep their
 * relative order, which keeps a shorthand adjacent to any longhand it overrides.
 */
const PROPERTY_ORDER = [
	'position', 'inset', 'top', 'right', 'bottom', 'left', 'z-index',
	'display', 'flex', 'grid', 'gap', 'row-gap', 'column-gap', 'align', 'justify', 'place', 'order',
	'box-sizing', 'aspect-ratio', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
	'inline-size', 'block-size', 'min-inline-size', 'min-block-size', 'max-inline-size', 'max-block-size',
	'overflow', 'float', 'clear', 'visibility',
	'margin', 'padding',
	'border-radius', 'border', 'outline',
	'background',
	'color', 'font', 'line-height', 'letter-spacing', 'word-spacing', 'text', 'white-space', 'tab-size',
	'direction', 'writing-mode', 'list-style', 'vertical-align',
	'box-shadow', 'opacity', 'filter', 'backdrop-filter', 'mix-blend-mode',
	'transform', 'transition', 'animation', 'cursor', 'pointer-events', 'user-select', 'will-change',
	'appearance', 'content',
];

/** The human-order rank of a property, or the end for a property no prefix matches. */
function rank(prop: string): number {
	for (let i = 0; i < PROPERTY_ORDER.length; i++) {
		if (prop.startsWith(PROPERTY_ORDER[i]!)) return i;
	}
	return PROPERTY_ORDER.length;
}

/**
 * Folds longhand families to shorthands and orders each rule's declarations like a human
 * would. Any infrastructure failure, or a reorder that is not render-neutral, returns the input.
 *
 * @param captured - source of the viewport size. Warnings are appended here on skip.
 */
export async function normalizeCss(css: string, captured: Captured, markup: string): Promise<string> {
	return withOracle(css, captured, markup, 'normalize: skipped', (oracle) => {
		oracle.captureReference();
		const topRules = Array.from(oracle.sheet.cssRules);
		for (const rule of topRules) {
			const styleRule = inScopeRule(rule);
			if (styleRule) reorderRule(styleRule);
		}
		if (!oracle.matchesReference()) {
			// Some reorder moved the render, from a shorthand mixed with a longhand it
			// overrides. Rather than diagnose which, ship the pruned css untouched.
			captured.warnings.push('normalize: reorder not render-neutral; shipped unnormalized');
			return css;
		}
		// Drop each longhand a preceding shorthand covers, withheld rules included. Neutral by
		// css definition, so no oracle re-check.
		const scratch = oracle.win.document.createElement('span').style;
		for (const rule of topRules) {
			if (rule.type === CSSRule.STYLE_RULE) dropCoveredLonghands(rule as CSSStyleRule, scratch);
		}
		return serializeRules(topRules);
	});
}

/**
 * Reorders one rule's declarations in place. Setting them back as a single cssText string lets
 * the cssom fold the now-adjacent families into shorthands as it reserializes. It preserves the
 * order of distinct properties, so the emitted rule keeps the grouping.
 *
 * @param styleRule - an in-scope style rule, reordered in place
 */
function reorderRule(styleRule: CSSStyleRule): void {
	const segs = parseSegments(styleRule.style.cssText);
	if (segs.length < 2) return;
	const sorted = segs.slice().sort((a, b) => rank(a.prop) - rank(b.prop));
	styleRule.style.cssText = sorted.map((s) => s.decl).join('; ');
}

/** One physical longhand the cssom stored for a declaration, with its normalized value. */
interface Longhand {
	name: string;
	value: string;
	priority: string;
}

/**
 * Drops each longhand a preceding shorthand in the same block already sets to that value. So
 * `border-radius: 4px` followed by its four corners at `4px` keeps only the shorthand. The
 * shorthand assigns that value regardless, so removing the restatement cannot change anything.
 *
 * A physical longhand drops whenever the covering shorthand implies its value, since a physical
 * side is writing-mode independent. A logical one drops only when the shorthand is uniform,
 * because only then does it not matter which physical side the logical name resolves to. A
 * longhand setting a different value clears the cover, so a restatement after it stays.
 *
 * @param styleRule - a style rule, in-scope or withheld, pruned in place
 */
function dropCoveredLonghands(styleRule: CSSStyleRule, scratch: CSSStyleDeclaration): void {
	const segs = parseSegments(styleRule.style.cssText);
	if (segs.length < 2) return;
	const covered = new Map<string, { value: string; priority: string; uniform: boolean }>();
	const kept: string[] = [];
	for (const seg of segs) {
		const items = expandDeclaration(scratch, seg.decl);
		const isShorthand = items.length > 1 || (items.length === 1 && items[0]!.name !== seg.prop);
		if (isShorthand) {
			kept.push(seg.decl);
			const uniform = items.every((it) => it.value === items[0]!.value && it.priority === items[0]!.priority);
			for (const it of items) covered.set(it.name, { value: it.value, priority: it.priority, uniform });
			continue;
		}
		const self = items[0];
		const physical = LOGICAL_TO_PHYSICAL[seg.prop] ?? seg.prop;
		const cover = covered.get(physical);
		const isLogical = physical !== seg.prop;
		if (self && cover && cover.value === self.value && cover.priority === self.priority && (!isLogical || cover.uniform)) {
			continue; // Redundant restatement of what the shorthand already sets.
		}
		kept.push(seg.decl);
		covered.delete(physical); // This longhand now governs the side; a later shorthand may re-cover it.
	}
	if (kept.length !== segs.length) styleRule.style.cssText = kept.join('; ');
}

/**
 * Expands one declaration to the physical longhands the cssom stores for it, with normalized
 * values and priorities. `border-radius` yields four corners; a plain longhand yields itself.
 * An empty array means the cssom rejected the declaration.
 */
function expandDeclaration(scratch: CSSStyleDeclaration, decl: string): Longhand[] {
	scratch.cssText = '';
	scratch.cssText = decl;
	const items: Longhand[] = [];
	for (let i = 0; i < scratch.length; i++) {
		const name = scratch.item(i);
		items.push({ name, value: scratch.getPropertyValue(name), priority: scratch.getPropertyPriority(name) });
	}
	return items;
}
