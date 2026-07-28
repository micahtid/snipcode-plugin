/**
 * utils/css-rules.ts: shared cssom rule predicates.
 *
 * The capture and minimize phases both walk stylesheets recursively and both need the same
 * question answered, so it is answered here once.
 */

/**
 * Whether a rule can hold child rules, so a walk should descend into it.
 *
 * Detected structurally rather than by lib type, because @layer and @container are recent
 * enough that the dom lib does not always declare them. Note that this is true of a plain
 * style rule too, since a style rule can nest children, so it is not a test for "at-rule
 * block". Every caller reaches it only after handling the rule types it treats specially.
 * test/unit.ts pins that against a live engine.
 */
export function holdsChildRules(rule: CSSRule): rule is CSSGroupingRule {
	return 'cssRules' in rule && (rule as { cssRules?: unknown }).cssRules instanceof CSSRuleList;
}
