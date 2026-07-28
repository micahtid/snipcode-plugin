/**
 * convert/bem.ts: inline styles to bem classes plus a stylesheet.
 *
 * Runs during the convert phase, on a deep copy of the clone, so the canonical clone is
 * untouched and every format stays derivable from one capture.
 *
 * Serves the html and bem-css formats, which want semantic classes and a separate
 * stylesheet rather than inline styles. Identical declaration sets dedupe into shared
 * bem-named classes (block plus block__element). Beyond that it factors a shared base
 * class out of near-identical rules, so a family of button variants ships its common
 * reset once; that pass is convert/bem-factor.ts, and the naming both passes share is
 * convert/bem-classes.ts.
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

	// Factor a shared base class out of near-identical rules, demoting each member to
	// a modifier carrying only its differences. Render-neutral by construction, so it
	// runs unconditionally.
	const { rules: finalRules, renames } = factorBaseClasses(block, rules, tagCounters);
	applyBaseClasses(elements, renames);

	const css = cssText(finalRules) + atRulesAppendix(captured);
	return { html: work.outerHTML, css };
}

/**
 * Read an element's inline declarations, snapping values for cleaner output. Parses
 * the serialized `style.cssText` rather than enumerating `style.item(i)`: a shorthand
 * set to a `var()` value, for example `border-color: var(--border)` or `margin: var(--gap)`, is
 * stored by the cssom as pending-substitution longhands whose `getPropertyValue` returns
 * the empty string, so item-enumeration would emit `border-top-color: ;` and the css
 * parser would silently drop the whole declaration. The serialized text preserves the
 * shorthand verbatim, exactly as the clone renders it, which is what the class output
 * must reproduce.
 */
function readDecls(el: HTMLElement): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	for (const [prop, value] of inlineDeclarations(el.style.cssText)) {
		out.push([prop, snapValue(prop, value).value]);
	}
	return out;
}

/**
 * Splits a serialized inline-style string into `[property, value]` pairs, using the shared
 * top-level scan in utils/css-split.ts, so a `;` or `:` inside parentheses, such as a
 * `url(data:...;base64,)` background or a nested function, or inside a quoted string is part
 * of the value and never a separator. An `!important` priority is stripped, matching the
 * prior getPropertyValue read. The class rules carry no competing selectors, so priority
 * changes nothing. A declaration with an empty property or an empty value is dropped.
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
