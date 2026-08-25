/**
 * minimize/declarations.ts: how the minimize phases read a declaration block.
 *
 * Shared by prune and normalize, so the two cannot drift on what they may touch or on how a
 * surviving rule serializes. The splitting itself is the shared scan in utils/css-split.ts;
 * this only puts a minimize-shaped face on it and lowercases the property name.
 */
import { parseDeclarations as parseCssDeclarations } from '../utils/css-split';

/**
 * Selectors held out of every minimize phase: dynamic pseudo-classes, the state and pseudo
 * markers, and any pseudo-element. They reproduce states invisible at rest, which a
 * resting-render oracle cannot verify. `:focus` covers `:focus-visible` and `:focus-within`
 * as a substring, and `::` covers every pseudo-element.
 */
export const WITHHELD = /:hover|:focus|:active|\[data-snip-state|\[data-snip-pseudo|::/;

/**
 * The rule as an in-scope style rule, meaning top-level and not withheld, or null. The type
 * comes from `rule.type` rather than `instanceof`, because the rule belongs to the oracle
 * iframe's realm and would fail an `instanceof` against this window's constructor.
 */
export function inScopeRule(rule: CSSRule): CSSStyleRule | null {
	if (rule.type !== CSSRule.STYLE_RULE) return null;
	const styleRule = rule as CSSStyleRule;
	if (WITHHELD.test(styleRule.selectorText || '')) return null;
	return styleRule;
}

/**
 * Serializes a stylesheet's top-level rules back to text. A style rule is emitted only when it
 * still carries declarations, so a rule some phase emptied is dropped. At-rules and grouping
 * rules go out verbatim in their original position.
 */
export function serializeRules(topRules: CSSRule[]): string {
	const out: string[] = [];
	for (const rule of topRules) {
		if (rule.type === CSSRule.STYLE_RULE) {
			const styleRule = rule as CSSStyleRule;
			if (styleRule.style.length > 0) out.push(styleRule.cssText); // An emptied rule is dropped.
			continue;
		}
		out.push(rule.cssText);
	}
	return out.join('\n\n');
}

/** One author declaration parsed from a rule: its lowercased property and full text. */
export interface Segment {
	/** The lowercased property name. */
	prop: string;
	/** The verbatim `prop: value` text, priority included, for faithful re-emission. */
	decl: string;
	/** The value text with the property and colon removed, priority still included. */
	value: string;
}

/**
 * Splits a declaration block into author declarations, shorthands kept whole. Top-level
 * semicolons only, so a `;` inside a data-uri never cuts a declaration, and each segment
 * keeps its verbatim text so re-emitting them reproduces the rule exactly.
 */
export function parseSegments(cssText: string): Segment[] {
	return parseCssDeclarations(cssText).map((d) => ({ prop: d.prop.toLowerCase(), decl: d.decl, value: d.value }));
}
