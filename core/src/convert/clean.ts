/**
 * convert/clean.ts: dead-code elimination on the emitted stylesheet.
 *
 * Removes exactly four kinds of dead code and nothing else: style rules whose selector matches
 * no element in the snip, custom properties nothing references, @font-face whose family is
 * never used, and @keyframes no animation names. Usage is measured against the actual markup
 * and the actual declarations, so it can never remove something the output depends on.
 *
 * Selector usage is measured against whatever markup the caller passes. The bem emitters
 * generate their class names on a private copy and leave captured.clone inline-styled, so a
 * generated .block__el selector matched against the clone would find nothing and wrongly drop
 * a live rule; those callers pass the emitted markup instead. The html path passes none and
 * matches the clone, which is correct because it ships only inline styles and at-rules.
 */
import type { Captured } from '../types';

const VAR_REF = /var\(\s*(--[A-Za-z0-9_-]+)/g;
/** keepRule returns this to signal "drop this rule". */
const DROP = '';

/**
 * Removes dead code from an emitted stylesheet.
 *
 *   inline-styled clone when absent. The html path passes none and matches the clone,
 *   its established behavior, since it ships only inline styles plus at-rules
 * @returns the cleaned stylesheet text
 */
export function cleanCss(css: string, captured: Captured, markup?: string): string {
	if (!css.trim()) return css;
	const sheet = new CSSStyleSheet();
	try {
		sheet.replaceSync(css);
	} catch {
		// Unparseable css, which is rare: return as-is rather than risk dropping content.
		return css;
	}

	const matchRoot = parseMatchRoot(markup) ?? captured.clone;
	const usage = collectUsage(captured, css);
	const kept: string[] = [];
	for (const rule of Array.from(sheet.cssRules)) {
		const text = keepRule(rule, matchRoot, usage);
		if (text) kept.push(text);
	}
	return kept.join('\n\n');
}

/**
 * Parses emitted markup into a container element for selector matching, returning
 * null on absent or unparseable markup so the caller falls back to the clone.
 *
 * @returns the parsed body element, whose descendants are the snip, or null
 */
function parseMatchRoot(markup: string | undefined): Element | null {
	if (!markup) return null;
	try {
		return new DOMParser().parseFromString(markup, 'text/html').body;
	} catch {
		return null;
	}
}

/** What the snip actually references, gathered from the clone + the css itself. */
interface Usage {
	families: Set<string>; // Lowercased font-family names in use
	animations: Set<string>; // Animation-name tokens in use
	vars: Set<string>; // --names referenced by var()
}

/**
 * Decides whether a single top-level rule survives. Returns its serialized text
 * to keep, or '' to drop. Recurses into grouping rules (@media/@supports) and
 * drops them if they end up empty.
 */
function keepRule(rule: CSSRule, matchRoot: Element, usage: Usage): string {
	if (rule instanceof CSSStyleRule) {
		// Keep custom-property-only :root rules pruned to referenced vars.
		// Keep element rules only if some element in the markup matches them.
		if (isRootVarRule(rule)) return pruneVarRule(rule, usage);
		return selectorMatchesSubtree(rule.selectorText, matchRoot) ? rule.cssText : DROP;
	}
	if (rule instanceof CSSFontFaceRule) {
		const family = (rule.style.getPropertyValue('font-family') || '').replace(/^["']|["']$/g, '').toLowerCase();
		return usage.families.has(family) ? rule.cssText : DROP; // An unused @font-face family
	}
	if (rule instanceof CSSKeyframesRule) {
		return usage.animations.has(rule.name) ? rule.cssText : DROP; // An unreferenced @keyframes
	}
	if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
		// Recurse. Keep the wrapper only if it still has live inner rules.
		const inner: string[] = [];
		for (const child of Array.from(rule.cssRules)) {
			const text = keepRule(child, matchRoot, usage);
			if (text) inner.push(text);
		}
		if (inner.length === 0) return DROP;
		const cond = rule instanceof CSSMediaRule ? `@media ${rule.conditionText}` : `@supports ${rule.conditionText}`;
		return `${cond} {\n${inner.join('\n')}\n}`;
	}
	// Unknown rule type, for example @layer or @property: keep verbatim, do not guess.
	return rule.cssText;
}

/** True when a selector matches the snip root or any descendant. */
function selectorMatchesSubtree(selector: string, root: Element): boolean {
	for (const branch of selector.split(',')) {
		const s = branch.trim();
		if (!s) continue;
		try {
			if (root.matches(s) || root.querySelector(s)) return true;
		} catch {
			// Unsupported selector, for example the ::selection pseudo: keep it, do not drop
			// something we cannot evaluate.
			return true;
		}
	}
	return false;
}

/** A :root / html rule that only defines custom properties. */
function isRootVarRule(rule: CSSStyleRule): boolean {
	if (!/(^|,)\s*(:root|html)\s*(,|$)/.test(rule.selectorText)) return false;
	for (let i = 0; i < rule.style.length; i++) {
		const prop = rule.style.item(i);
		if (prop && !prop.startsWith('--')) return false;
	}
	return true;
}

/** Drop unreferenced custom properties from a :root var rule. */
function pruneVarRule(rule: CSSStyleRule, usage: Usage): string {
	const kept: string[] = [];
	for (let i = 0; i < rule.style.length; i++) {
		const prop = rule.style.item(i);
		if (!prop) continue;
		if (usage.vars.has(prop)) kept.push(`\t${prop}: ${rule.style.getPropertyValue(prop)};`);
	}
	if (kept.length === 0) return DROP;
	return `${rule.selectorText} {\n${kept.join('\n')}\n}`;
}

/**
 * Gathers all font-family, animation-name, and var() usage from both the clone
 * subtree's inline styles and the css text's class-based rules, so the cleaner
 * works for inline html and class-based formats alike.
 */
function collectUsage(captured: Captured, css: string): Usage {
	const families = new Set<string>();
	const animations = new Set<string>();
	const vars = new Set<string>();

	// From the clone subtree's inline styles.
	for (const [, baked] of captured.bakedStyles) {
		addFamilies(baked.get('font-family'), families);
		addFamilies(baked.get('font'), families);
		addAnimations(baked.get('animation'), animations);
		addAnimations(baked.get('animation-name'), animations);
		for (const value of baked.values()) addVars(value, vars);
	}
	// From the css text. This covers class-based rules and any @media bodies.
	addFamilies(matchAll(css, /font-family\s*:\s*([^;}{]+)/gi), families);
	addAnimations(matchAll(css, /animation(?:-name)?\s*:\s*([^;}{]+)/gi), animations);
	addVars(css, vars);

	return { families, animations, vars };
}

/** Split a font-family value list into lowercased family names. */
function addFamilies(value: string | string[] | undefined, into: Set<string>): void {
	if (!value) return;
	const values = Array.isArray(value) ? value : [value];
	for (const v of values) {
		for (const token of v.split(',')) {
			const name = token.replace(/^["']|["']$/g, '').trim().toLowerCase();
			if (name) into.add(name);
		}
	}
}

/** Collect animation-name tokens. A name can never collide with a duration token. */
function addAnimations(value: string | string[] | undefined, into: Set<string>): void {
	if (!value) return;
	const values = Array.isArray(value) ? value : [value];
	for (const v of values) {
		for (const part of v.split(',')) {
			for (const token of part.trim().split(/\s+/)) {
				const t = token.trim();
				if (t) into.add(t);
			}
		}
	}
}

/** Collect --names referenced by var() in a string. */
function addVars(value: string | undefined, into: Set<string>): void {
	if (!value) return;
	let m: RegExpExecArray | null;
	VAR_REF.lastIndex = 0;
	while ((m = VAR_REF.exec(value)) !== null) {
		if (m[1]) into.add(m[1]);
	}
}

/** Run a capture-group regex over text and return all group-1 matches. */
function matchAll(text: string, re: RegExp): string[] {
	const out: string[] = [];
	let m: RegExpExecArray | null;
	re.lastIndex = 0;
	while ((m = re.exec(text)) !== null) {
		if (m[1]) out.push(m[1]);
	}
	return out;
}
