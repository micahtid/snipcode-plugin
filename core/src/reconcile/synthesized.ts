/**
 * reconcile/synthesized.ts: the one <style> node the handlers share.
 *
 * The pseudo and state handlers both need real css rules, which an inline style cannot express.
 * If each managed its own <style> the clone would carry several, their order would follow
 * handler order, and the formatter would have to find them all. One node, created on first use
 * and appended at a fixed place, removes that.
 */
import type { Captured } from '../types';

/** Marks the single synthesized <style> on the clone, so resolve can find it and lift can strip it. */
const SYNTH_MARKER = 'data-snip-synth';

/**
 * A void element serializes no children, so a <style> appended to a void snip root would be
 * dropped by outerHTML. The handlers warn rather than lose the rules without trace.
 */
const VOID_TAGS = new Set([
	'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
	'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * Appends synthesized rules to the clone's shared <style>, creating it on first use, so every
 * such rule lands in one block in handler order.
 *
 * @param captured - clone + warnings mutated in place
 */
export function appendSynthesizedRules(captured: Captured, rules: string[]): void {
	if (rules.length === 0) return;
	// A void root cannot carry a child <style>, so the rules cannot attach to the artifact.
	if (VOID_TAGS.has(captured.clone.tagName.toLowerCase())) {
		captured.warnings.push(
			`reconcile: ${rules.length} synthesized rule(s) could not attach to a void root <${captured.clone.tagName.toLowerCase()}>`,
		);
		return;
	}
	const style = synthesizedStyle(captured) ?? createSynthesizedStyle(captured);
	const existing = style.textContent ?? '';
	style.textContent = existing ? `${existing}\n${rules.join('\n')}` : rules.join('\n');
}

/** The clone's synthesized <style>, or null when no handler has created one. */
export function synthesizedStyle(captured: Captured): HTMLStyleElement | null {
	return captured.clone.querySelector(`style[${SYNTH_MARKER}]`);
}

/** Creates the marked synthesized <style> as a child of the clone root. */
function createSynthesizedStyle(captured: Captured): HTMLStyleElement {
	const style = document.createElement('style');
	style.setAttribute(SYNTH_MARKER, '');
	captured.clone.appendChild(style);
	return style;
}

/** One declaration of a synthesized rule, with the selector it belongs to. */
export interface SynthesizedDeclaration {
	/** The owning rule's selector, e.g. `[data-snip-state="0"]:hover`. */
	selector: string;
	/** The longhand or shorthand property name. */
	prop: string;
	/** The declaration value, without any `!important`. */
	value: string;
	/** Whether the declaration carries `!important`. */
	important: boolean;
}

/** One parsed synthesized rule: its selector and the declarations under it. */
interface SynthesizedRule {
	selector: string;
	declarations: SynthesizedDeclaration[];
}

/**
 * Walks every declaration in the synthesized <style>, read-only. The resolve passes gather the
 * url() and var() references from here, which the resting bake never sees.
 */
export function forEachSynthesizedDeclaration(captured: Captured, fn: (decl: SynthesizedDeclaration) => void): void {
	const style = synthesizedStyle(captured);
	if (!style) return;
	for (const rule of parseSynthesized(style)) for (const decl of rule.declarations) fn(decl);
}

/**
 * Rewrites the synthesized <style> declaration by declaration. The transform returns a new
 * value, the same value to keep it, or null to drop it, and a rule left empty is removed. This
 * is the one place the resolve phase mutates synthesized rules.
 *
 * Parsing is line-based over the shape the handlers emit, deliberately not a cssom round-trip.
 * A shorthand carrying a var() does not enumerate as longhands, so a re-serialize would
 * silently drop it. Working on the text preserves every declaration verbatim.
 *
 * @param captured - the capture whose synthesized <style> is rewritten in place
 * @param transform - maps a declaration's value to a new value, or null to drop it
 */
export function rewriteSynthesizedDeclarations(
	captured: Captured,
	transform: (decl: SynthesizedDeclaration) => string | null,
): void {
	const style = synthesizedStyle(captured);
	if (!style) return;
	const blocks: string[] = [];
	for (const rule of parseSynthesized(style)) {
		const lines: string[] = [];
		for (const decl of rule.declarations) {
			const next = transform(decl);
			if (next === null) continue;
			lines.push(`\t${decl.prop}: ${next}${decl.important ? ' !important' : ''};`);
		}
		if (lines.length > 0) blocks.push(`${rule.selector} {\n${lines.join('\n')}\n}`);
	}
	style.textContent = blocks.join('\n');
}

/**
 * Parses the synthesized <style> into rules and declarations. The text is always in the
 * handlers' one-declaration-per-line shape, so a line parser is exact and avoids the cssom's
 * shorthand-with-var() loss. See rewriteSynthesizedDeclarations.
 */
function parseSynthesized(style: HTMLStyleElement): SynthesizedRule[] {
	const rules: SynthesizedRule[] = [];
	let current: SynthesizedRule | null = null;
	for (const line of (style.textContent ?? '').split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '') continue;
		if (trimmed.endsWith('{')) {
			current = { selector: trimmed.slice(0, -1).trim(), declarations: [] };
			rules.push(current);
		} else if (trimmed === '}') {
			current = null;
		} else if (current) {
			const decl = parseDeclaration(current.selector, trimmed);
			if (decl) current.declarations.push(decl);
		}
	}
	return rules;
}

/** Parse one `prop: value;` or `prop: value !important;` declaration line. */
function parseDeclaration(selector: string, line: string): SynthesizedDeclaration | null {
	const text = line.replace(/;$/, '');
	const colon = text.indexOf(':'); // The first colon. A url(http:) in the value cannot precede it.
	if (colon === -1) return null;
	const prop = text.slice(0, colon).trim();
	let value = text.slice(colon + 1).trim();
	const important = /!\s*important$/i.test(value);
	if (important) value = value.replace(/!\s*important$/i, '').trim();
	if (!prop || !value) return null;
	return { selector, prop, value, important };
}
