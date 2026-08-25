/**
 * convert/bem.ts: inline styles to bem classes plus a stylesheet.
 *
 * Runs during the convert phase, on a deep copy of the clone, so the canonical clone is
 * untouched and every format stays derivable from one capture.
 *
 * Serves the html and bem-css formats, which want semantic classes and a separate stylesheet.
 * Identical declaration sets dedupe into shared block and block__element classes. Then
 * convert/bem-factor.ts factors a base class out of near-identical rules, so a family of
 * button variants ships its reset once. convert/bem-classes.ts is the naming both share.
 */
import type { Captured } from '../types';
import { snapValue } from './snap';
import { parseDeclarations, stripImportant } from '../utils/css-split';
import { atRulesCss, type HtmlOutput } from './document';
import { firstClassOrTag, sanitize, uniqueElementClass, type ClassRule } from './bem-classes';
import { applyBaseClasses, factorBaseClasses } from './bem-factor';

/**
 * Emits the snip as bem-classed markup plus a flat css stylesheet.
 *
 * @param captured - read-only, so a deep copy of the clone is transformed
 */
export function emitBem(captured: Captured): HtmlOutput {
	const work = captured.clone.cloneNode(true) as Element;
	const block = sanitize(firstClassOrTag(work)) || 'snip';
	const elements = [work, ...Array.from(work.querySelectorAll('*'))] as HTMLElement[];

	const byDecls = new Map<string, ClassRule>(); // declString -> class, for dedup
	const rules: ClassRule[] = [];
	const tagCounters = new Map<string, number>();

	for (const el of elements) {
		const decls = readDecls(el);
		el.removeAttribute('style');
		if (decls.length === 0) {
			el.removeAttribute('class');
			continue;
		}
		const isRoot = el === work;
		const key = declKey(decls);
		let rule = byDecls.get(key);
		if (!rule) {
			const className = isRoot ? block : uniqueElementClass(block, el.tagName.toLowerCase(), tagCounters);
			rule = { className, decls, isRoot };
			byDecls.set(key, rule);
			rules.push(rule);
		}
		el.setAttribute('class', rule.className);
	}

	// Factor a base class out of near-identical rules, demoting each member to a modifier
	// carrying only its differences. Render-neutral by construction, so it always runs.
	const { rules: finalRules, renames } = factorBaseClasses(block, rules, tagCounters);
	applyBaseClasses(elements, renames);

	const css = cssText(finalRules) + atRulesAppendix(captured);
	return { html: work.outerHTML, css };
}

/**
 * An element's inline declarations, values snapped for cleaner output. It parses the serialized
 * `style.cssText` rather than enumerating item(i), because a shorthand set to a `var()` is
 * stored as pending-substitution longhands whose getPropertyValue returns empty. Enumeration
 * would emit `border-top-color: ;` and the parser would drop the whole declaration; the
 * serialized text keeps the shorthand exactly as the clone renders it.
 */
function readDecls(el: HTMLElement): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	for (const [prop, value] of inlineDeclarations(el.style.cssText)) {
		out.push([prop, snapValue(prop, value).value]);
	}
	return out;
}

/**
 * Splits a serialized inline style into `[property, value]` pairs with the shared top-level
 * scan, so a `;` or `:` inside a data uri stays in the value. Priority is stripped, which
 * changes nothing because the class rules carry no competing selectors.
 */
function inlineDeclarations(cssText: string): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	for (const { prop, value } of parseDeclarations(cssText)) {
		const bare = stripImportant(value);
		if (prop && bare) out.push([prop, bare]);
	}
	return out;
}

/** A stable key over a declaration set so identical sets share one class. */
function declKey(decls: Array<[string, string]>): string {
	return [...decls]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([p, v]) => `${p}:${v}`)
		.join(';');
}

/** Flat css: one rule per generated class. */
function cssText(rules: ClassRule[]): string {
	return rules.map((r) => `.${r.className} {\n${declLines(r.decls)}\n}`).join('\n\n');
}

/** Serialize declarations as indented `prop: value;` lines. */
function declLines(decls: Array<[string, string]>, indent = 1): string {
	const pad = '\t'.repeat(indent);
	return decls.map(([p, v]) => `${pad}${p}: ${v};`).join('\n');
}

/** The @font-face/@keyframes block, prefixed with a blank line if present. */
function atRulesAppendix(captured: Captured): string {
	const at = atRulesCss(captured);
	return at ? `\n\n${at}` : '';
}
