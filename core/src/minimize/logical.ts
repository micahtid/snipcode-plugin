/**
 * minimize/logical.ts: folding logical properties to physical.
 *
 * Runs in minimize, between prune and normalize. The engine computes margin-inline-start where
 * the page wrote margin-left, and left logical the four corner radii never fold, because
 * border-radius is physical.
 *
 * The rewrite applies only where every matched element is horizontal-tb and ltr, which is where
 * the spec makes the two equivalent. A vertical or rtl element keeps its logical properties.
 * Render-neutral by construction, and oracle-checked anyway as a backstop.
 */
import type { Captured } from '../types';
import { withOracle } from './oracle';
import { inScopeRule, parseSegments, serializeRules } from './declarations';
import { splitTopLevel } from '../utils/css-split';

/**
 * Logical longhands and one-value directionals mapped to their horizontal-tb ltr physical name.
 * Exported so the covered-longhand drop in normalize can fold a logical corner name to physical
 * when testing whether a preceding shorthand already covers it.
 */
export const LOGICAL_TO_PHYSICAL: Record<string, string> = {
	'border-start-start-radius': 'border-top-left-radius',
	'border-start-end-radius': 'border-top-right-radius',
	'border-end-start-radius': 'border-bottom-left-radius',
	'border-end-end-radius': 'border-bottom-right-radius',
	'inset-block-start': 'top', 'inset-block-end': 'bottom', 'inset-inline-start': 'left', 'inset-inline-end': 'right',
	'margin-block-start': 'margin-top', 'margin-block-end': 'margin-bottom', 'margin-inline-start': 'margin-left', 'margin-inline-end': 'margin-right',
	'padding-block-start': 'padding-top', 'padding-block-end': 'padding-bottom', 'padding-inline-start': 'padding-left', 'padding-inline-end': 'padding-right',
	'block-size': 'height', 'inline-size': 'width',
	'min-block-size': 'min-height', 'max-block-size': 'max-height', 'min-inline-size': 'min-width', 'max-inline-size': 'max-width',
	'border-block-start': 'border-top', 'border-block-end': 'border-bottom', 'border-inline-start': 'border-left', 'border-inline-end': 'border-right',
	'border-block-start-width': 'border-top-width', 'border-block-start-style': 'border-top-style', 'border-block-start-color': 'border-top-color',
	'border-block-end-width': 'border-bottom-width', 'border-block-end-style': 'border-bottom-style', 'border-block-end-color': 'border-bottom-color',
	'border-inline-start-width': 'border-left-width', 'border-inline-start-style': 'border-left-style', 'border-inline-start-color': 'border-left-color',
	'border-inline-end-width': 'border-right-width', 'border-inline-end-style': 'border-right-style', 'border-inline-end-color': 'border-right-color',
};

/** Two-value logical shorthands: the value's start half maps to the first physical side, the end half to the second. */
const PAIR: Record<string, [string, string]> = {
	'margin-block': ['margin-top', 'margin-bottom'], 'margin-inline': ['margin-left', 'margin-right'],
	'padding-block': ['padding-top', 'padding-bottom'], 'padding-inline': ['padding-left', 'padding-right'],
	'inset-block': ['top', 'bottom'], 'inset-inline': ['left', 'right'],
};

/** Logical border shorthands whose single value applies to both physical sides. */
const BOTH: Record<string, [string, string]> = {
	'border-block': ['border-top', 'border-bottom'], 'border-inline': ['border-left', 'border-right'],
};

/** True when any known logical property occurs, so the oracle mount can be skipped otherwise. */
const HAS_LOGICAL = /(?:^|[;{\s])(?:border-(?:start|end)-(?:start|end)-radius|(?:inset|margin|padding|border)-(?:block|inline)|(?:block|inline|min-block|max-block|min-inline|max-inline)-size)/;

/**
 * Rewrites logical properties to physical wherever every matched element is horizontal-tb and
 * ltr. Any infrastructure failure returns the input, and a rule whose rewrite is not
 * render-neutral reverts. Document order throughout, so the result is deterministic.
 *
 * @param captured - source of the viewport size. Warnings are appended here on skip.
 */
export async function foldLogical(css: string, captured: Captured, markup: string): Promise<string> {
	if (!HAS_LOGICAL.test(css)) return css;
	return withOracle(css, captured, markup, 'minimize: logical fold skipped', (oracle) => {
		oracle.captureReference();
		for (const rule of Array.from(oracle.sheet.cssRules)) {
			const styleRule = inScopeRule(rule);
			if (!styleRule || !HAS_LOGICAL.test(styleRule.style.cssText)) continue;
			let elements: Element[];
			try {
				elements = Array.from(oracle.body.querySelectorAll(styleRule.selectorText));
			} catch {
				continue;
			}
			if (elements.length === 0 || !elements.every((el) => isHorizontalLtr(oracle.win, el))) continue;

			const rewritten = rewrite(styleRule.style.cssText);
			if (rewritten === null) continue;
			const saved = styleRule.style.cssText;
			styleRule.style.cssText = rewritten;
			// Neutral by construction here; the oracle only backstops a mishandled value.
			if (!oracle.matchesSubset(oracle.subtreeTargets(elements))) styleRule.style.cssText = saved;
		}
		return serializeRules(Array.from(oracle.sheet.cssRules));
	});
}

/** Whether an element lays out horizontally, left to right, so logical equals physical. */
function isHorizontalLtr(win: Window, el: Element): boolean {
	const cs = win.getComputedStyle(el);
	return cs.writingMode === 'horizontal-tb' && cs.direction === 'ltr';
}

/**
 * Rewrites a rule's logical declarations to physical, or null when it holds none. A longhand is
 * renamed, a two-value shorthand splits across its two sides, and a border block or inline
 * shorthand copies to both.
 */
function rewrite(cssText: string): string | null {
	let changed = false;
	const out: string[] = [];
	for (const seg of parseSegments(cssText)) {
		const prop = seg.prop;
		if (LOGICAL_TO_PHYSICAL[prop]) {
			out.push(`${LOGICAL_TO_PHYSICAL[prop]}: ${seg.value}`);
			changed = true;
		} else if (PAIR[prop]) {
			const [start, end] = splitPair(seg.value);
			out.push(`${PAIR[prop]![0]}: ${start}`, `${PAIR[prop]![1]}: ${end}`);
			changed = true;
		} else if (BOTH[prop]) {
			out.push(`${BOTH[prop]![0]}: ${seg.value}`, `${BOTH[prop]![1]}: ${seg.value}`);
			changed = true;
		} else {
			out.push(seg.decl);
		}
	}
	return changed ? out.join('; ') : null;
}

/**
 * Splits a two-value logical value into its start and end halves, carrying any priority to
 * both. A single value applies to both sides, and the split is top-level so a function's own
 * spaces do not cut it.
 */
function splitPair(value: string): [string, string] {
	const bang = /\s*!important\s*$/i.exec(value);
	const important = bang ? ' !important' : '';
	const core = bang ? value.slice(0, bang.index) : value;
	const parts = topLevelParts(core.trim());
	const start = parts[0] ?? '';
	const end = parts[1] ?? start;
	return [`${start}${important}`, `${end}${important}`];
}

/** Splits a value on top-level whitespace, keeping function arguments and their spaces intact. */
function topLevelParts(value: string): string[] {
	return splitTopLevel(value, /\s/).filter(Boolean);
}
