/**
 * minimize/declarations.ts: shared css declaration-block parsing
 *
 * Pipeline position: minimize, a helper for prune and normalize
 * Reads from Captured: nothing
 * Writes to Captured: nothing
 *
 * Why this exists: both the prune phase and the normalize phase need to split a rule's
 * serialized declaration block into its author declarations, keeping shorthands whole and
 * never splitting on a semicolon inside a url, a function, or a quoted string, and both
 * need the same notion of which rules are in scope and how the surviving rules serialize.
 * Defining those once here keeps the phases from drifting apart on what they may touch.
 *
 * The splitting itself is not written here. It is the shared scan in utils/css-split.ts,
 * which every phase and every emitter uses. This module only puts a minimize-shaped face
 * on it, lowercasing the property so phase lookups are case insensitive.
 */
import { parseDeclarations as parseCssDeclarations } from '../utils/css-split';

/**
 * Selectors held out of every minimize phase: dynamic pseudo-classes, the measured-state
 * and pseudo-element markers, and any pseudo-element. These rules reproduce interactive and
 * generated-content states that are invisible at rest, so the resting-render oracle cannot
 * verify them and must not touch them. `:focus` also covers `:focus-visible` and
 * `:focus-within` as a substring, and `::` covers every pseudo-element.
 */
export const WITHHELD = /:hover|:focus|:active|\[data-snip-state|\[data-snip-pseudo|::/;

/**
 * The rule as an in-scope style rule, or null when out of scope. In scope means a top-level
 * style rule whose selector is not withheld. The type is read from `rule.type` rather than
 * `instanceof`, because the rule belongs to the oracle iframe's realm and would fail an
 * `instanceof CSSStyleRule` against this window's constructor, while `CSSRule.STYLE_RULE` is
 * the same numeric constant in every realm.
 *
 * @param rule - a top-level rule from an oracle frame's stylesheet
 */
export function inScopeRule(rule: CSSRule): CSSStyleRule | null {
	if (rule.type !== CSSRule.STYLE_RULE) return null;
	const styleRule = rule as CSSStyleRule;
	if (WITHHELD.test(styleRule.selectorText || '')) return null;
	return styleRule;
}

/**
 * Serializes a stylesheet's top-level rules back to text. A style rule is emitted only when
 * it still carries declarations, so a rule a phase emptied is dropped, whether it is in scope
 * or a withheld state or pseudo rule the merge collapsed into a selector list. At-rules and
 * grouping rules are emitted verbatim in their original position.
 *
 * @param topRules - a frame stylesheet's top-level rules
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
 * Splits a serialized declaration block into author declarations, keeping shorthands
 * whole. Splits on top-level semicolons only, so a `;` inside a url(), a function, or a
 * quoted string, such as a data-uri background, never splits a declaration. Each segment
 * keeps its verbatim text, priority included, so re-emitting the segments reproduces the
 * rule exactly.
 *
 * @param cssText - a rule's serialized declaration block, no braces
 */
export function parseSegments(cssText: string): Segment[] {
	return parseCssDeclarations(cssText).map((d) => ({ prop: d.prop.toLowerCase(), decl: d.decl, value: d.value }));
}
