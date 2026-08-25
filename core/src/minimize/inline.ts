/**
 * minimize/inline.ts: resolving var() to the value it actually holds.
 *
 * Runs in minimize, after the at-rule purge. Reconcile bakes a wall of custom properties onto
 * the rules and reads them back through var(). This resolves each reference over the elements
 * its rule matches, substitutes only when they all agree, then drops what nothing references.
 *
 * The substitution is oracle-gated and reverted whole if anything moved. The deletion is not,
 * and cannot be. getComputedStyle enumerates a custom property, so removing an unreferenced
 * declaration changes its own computed value and the oracle would veto a no-op.
 *
 * A property carrying motion the resting frame cannot see is left alone: named in @keyframes,
 * listed in a transition, or redefined by a state rule. That last matters most, since inlining
 * a resting `color: var(--x)` a :hover redefines would freeze it and strip the state change.
 */
import type { Captured } from '../types';
import { withOracle, type RenderOracle } from './oracle';
import { inScopeRule, parseSegments, serializeRules, WITHHELD } from './declarations';

/**
 * Resolves `var()` to its per-site value and drops the custom properties left unreferenced.
 * Any infrastructure failure returns the input unchanged, and inlining that is not
 * render-neutral reverts on its own while the dead declarations still go. Document order
 * throughout, so the result is deterministic.
 *
 * @param captured - source of the viewport size. Warnings are appended here on skip.
 */
export async function inlineVars(css: string, captured: Captured, markup: string): Promise<string> {
	if (!css.includes('var(')) return css;
	return withOracle(css, captured, markup, 'minimize: var inline skipped', (oracle) => {
		oracle.captureReference();
		const held = motionHeldNames(css);
		addStateRedefinedNames(oracle.sheet, held);

		// Inline every reference, then verify the batch. A wrong substitution changes a
		// computed longhand, so the whole inlining reverts and the input rules stand.
		const inScope = Array.from(oracle.sheet.cssRules).map(inScopeRule).filter((r): r is CSSStyleRule => r !== null);
		const saved = inScope.map((r) => r.style.cssText);
		for (const rule of inScope) inlineRule(oracle, rule, held);
		if (!oracle.matchesReference()) inScope.forEach((r, i) => (r.style.cssText = saved[i]!));

		// Drop the custom properties no surviving var() references and no motion holds. By
		// construction, not oracle-gated: an unreferenced custom property paints nothing, but
		// the oracle enumerates its computed value and would read the removal as a change.
		dropDeadCustomProps(oracle.sheet, inScope, held);
		return serializeRules(Array.from(oracle.sheet.cssRules));
	});
}

/**
 * The custom properties carrying motion the resting frame cannot sample, so they are neither
 * inlined nor dropped. A name written inside @keyframes, or listed in a transition or
 * animation value. A bare `@property` registration is not a reason to hold. A registered name
 * nothing animates governs no motion, and holding it would keep alive the very dead pair the
 * at-rule purge exists to drop. addStateRedefinedNames adds the third carrier below.
 */
function motionHeldNames(css: string): Set<string> {
	const held = new Set<string>();
	for (const block of css.matchAll(/@keyframes[^{]*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
		for (const m of block[1]!.matchAll(/(--[\w-]+)/g)) held.add(m[1]!);
	}
	// A custom property named in a transition or animation shorthand or longhand is animated.
	for (const m of css.matchAll(/(?:transition|transition-property|animation|animation-name)\s*:[^;}]*/g)) {
		for (const t of m[0].matchAll(/(--[\w-]+)/g)) held.add(t[1]!);
	}
	return held;
}

/**
 * Adds every custom property a withheld state or pseudo rule declares. Such a property changes
 * with the state, so a resting rule reading it through var() is dynamic. Inlining that
 * reference would freeze it and drop the state change.
 *
 * @param held - the motion-held name set, extended in place
 */
function addStateRedefinedNames(sheet: CSSStyleSheet, held: Set<string>): void {
	for (const rule of Array.from(sheet.cssRules)) {
		if (rule.type !== CSSRule.STYLE_RULE) continue;
		const styleRule = rule as CSSStyleRule;
		if (!WITHHELD.test(styleRule.selectorText || '')) continue;
		for (const seg of parseSegments(styleRule.style.cssText)) if (seg.prop.startsWith('--')) held.add(seg.prop);
	}
}

/**
 * Inlines one rule's var() references in place. Each reference whose name is not motion-held
 * resolves to the value it holds on every element the rule matches. The substitution happens
 * only when they all agree on a non-empty one.
 */
function inlineRule(oracle: RenderOracle, rule: CSSStyleRule, held: Set<string>): void {
	if (!rule.style.cssText.includes('var(')) return;
	let elements: Element[];
	try {
		elements = Array.from(oracle.body.querySelectorAll(rule.selectorText));
	} catch {
		return;
	}
	if (elements.length === 0) return;
	const win = oracle.win;
	const resolve = (name: string): string | null => {
		if (held.has(name)) return null;
		let value: string | null = null;
		for (const el of elements) {
			const v = win.getComputedStyle(el).getPropertyValue(name).trim();
			if (!v) return null; // Unset here (a fallback would apply), so leave the reference.
			if (value === null) value = v;
			else if (value !== v) return null; // Differs across the rule's elements, so not one value.
		}
		return value;
	};
	const rebuilt = parseSegments(rule.style.cssText)
		.map((seg) => `${seg.prop}: ${substituteVars(seg.value, resolve)}`)
		.join('; ');
	rule.style.cssText = rebuilt;
}

/**
 * Substitutes the resolvable `var()` references in a value, walking the text and matching each
 * `var(` to its closing paren so a nested fallback or calc() is spanned whole. A var() inside
 * a kept reference's fallback is reached by re-walking the remainder.
 *
 * @param resolve - maps a custom-property name to its site value, or null to leave the ref
 */
function substituteVars(value: string, resolve: (name: string) => string | null): string {
	let out = '';
	let i = 0;
	while (i < value.length) {
		const start = value.indexOf('var(', i);
		if (start === -1) {
			out += value.slice(i);
			break;
		}
		out += value.slice(i, start);
		const end = matchParen(value, start + 3);
		if (end === -1) {
			out += value.slice(start);
			break;
		}
		const inner = value.slice(start + 4, end); // Between var( and )
		const comma = topLevelComma(inner);
		const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
		const resolved = /^--[\w-]+$/.test(name) ? resolve(name) : null;
		if (resolved !== null) {
			out += resolved;
			i = end + 1;
		} else {
			// Keep this reference verbatim, but still resolve any var() nested in its fallback.
			out += `var(${substituteVars(inner, resolve)})`;
			i = end + 1;
		}
	}
	return out;
}

/** The index of the paren that closes the `(` at `open`, or -1 when unbalanced. */
function matchParen(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === '(') depth++;
		else if (text[i] === ')' && --depth === 0) return i;
	}
	return -1;
}

/** The index of the first top-level comma in a var()'s inner text, or -1 when there is none. */
function topLevelComma(inner: string): number {
	let depth = 0;
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		else if (ch === ',' && depth === 0) return i;
	}
	return -1;
}

/**
 * Removes every custom property whose name no longer appears in a `var()` anywhere in the
 * sheet and is not motion-held. A name still read from any rule, or from a fallback, is
 * load-bearing and stays. Removal runs on the cssom, so the parser handles a value carrying a
 * `;` inside a url() rather than a text split.
 *
 * @param sheet - the mounted stylesheet, mutated in place
 */
function dropDeadCustomProps(sheet: CSSStyleSheet, inScope: CSSStyleRule[], held: Set<string>): void {
	const referenced = new Set<string>();
	for (const m of serializeRules(Array.from(sheet.cssRules)).matchAll(/var\(\s*(--[\w-]+)/g)) referenced.add(m[1]!);
	for (const rule of inScope) {
		for (const seg of parseSegments(rule.style.cssText)) {
			if (seg.prop.startsWith('--') && !referenced.has(seg.prop) && !held.has(seg.prop)) rule.style.removeProperty(seg.prop);
		}
	}
}
