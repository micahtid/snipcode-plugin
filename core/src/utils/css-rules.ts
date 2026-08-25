/**
 * utils/css-rules.ts: shared cssom parsing and rule predicates.
 *
 * Several phases walk or rewrite a stylesheet, and they all start by asking the engine the
 * same two things: parse this text, and does this rule hold children. Answered here once.
 */

/**
 * Parses css text into a constructable stylesheet, or null when the engine rejects it. The
 * sheet is never adopted, so this reads the engine's parser without touching the live page.
 * Null is the graceful path: a whole-sheet rewrite that cannot parse returns its input.
 */
export function parseCss(css: string): CSSStyleSheet | null {
	try {
		const sheet = new CSSStyleSheet();
		sheet.replaceSync(css);
		return sheet;
	} catch {
		return null;
	}
}

/**
 * The top-level rule list of every stylesheet the document will let us read, in order. A
 * cross-origin sheet throws on .cssRules, the boundary every cssom read accepts. Its href goes
 * to `unreadable`, so a caller that can recover the text through the Host does.
 */
export function readableRuleLists(unreadable?: string[]): CSSRuleList[] {
	const out: CSSRuleList[] = [];
	for (const sheet of Array.from(document.styleSheets)) {
		try {
			out.push(sheet.cssRules);
		} catch {
			if (sheet.href) unreadable?.push(sheet.href);
		}
	}
	return out;
}

/**
 * Whether a rule can hold child rules, so a walk should descend into it. Detected
 * structurally, because the dom lib does not always declare @layer and @container.
 *
 * It is true of a plain style rule too, since those nest, so it is not a test for "at-rule
 * block". Every caller reaches it only after handling the types it treats specially, which
 * test/unit.ts pins against a live engine.
 */
export function holdsChildRules(rule: CSSRule): rule is CSSGroupingRule {
	return 'cssRules' in rule && (rule as { cssRules?: unknown }).cssRules instanceof CSSRuleList;
}
