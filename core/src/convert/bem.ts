/**
 * convert/bem.ts: inline styles -> bem classes + css/scss
 *
 * Pipeline position: convert
 * Reads from Captured: clone, inline-styled
 * Writes to Captured: nothing. It deep-copies the clone, so the canonical clone is untouched.
 *
 * A format transform of the baked result.
 *
 * Why this exists: the bem-css and bem-scss formats want semantic
 * classes and a separate stylesheet instead of inline styles. This dedups
 * identical declaration sets into shared bem-named classes (block + block__element)
 * and emits either a flat css ruleset or a nested scss block. Like the other
 * emitters it works on a copy of the clone so all 7 formats stay derivable from
 * one capture. Ported from v1 css-to-bem.ts, the inline-to-class dedup, rewritten
 * and dropping the per-case branches.
 *
 * Beyond identical-set dedup it factors a shared base class out of near-identical rules,
 * so a family of button variants ships its common reset once. That pass is
 * convert/bem-factor.ts, and the class naming both passes share is convert/bem-classes.ts.
 */
import type { Captured } from '../types';
import { snapValue } from './snap';
import { parseDeclarations, stripImportant } from '../utils/css-split';
import { atRulesCss, type HtmlOutput } from './html';
import { firstClassOrTag, sanitize, uniqueElementClass, type ClassRule } from './bem-classes';
import { applyBaseClasses, factorBaseClasses } from './bem-factor';

/**
 * Emits the snip as bem-classed markup plus a css or scss stylesheet.
 *
 * @param captured - read-only, so a deep copy of the clone is transformed
 * @param scss - true for nested scss output, false for flat css
 */
export function emitBem(captured: Captured, scss: boolean): HtmlOutput {
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
	// runs unconditionally. The screenshot grader is the backstop.
	const { rules: finalRules, renames } = factorBaseClasses(block, rules, tagCounters);
	applyBaseClasses(elements, renames);

	const css = (scss ? scssText(block, finalRules) : cssText(finalRules)) + atRulesAppendix(captured);
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
 *
 * @param cssText - the element's serialized inline style
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

/**
 * Nested scss: the block rule with its element rules nested via `&__...`. Bem
 * names are flat regardless of dom depth, so every element rule nests one level
 * under the block.
 */
function scssText(block: string, rules: ClassRule[]): string {
	const root = rules.find((r) => r.isRoot);
	const children = rules.filter((r) => !r.isRoot);
	const inner = children
		.map((r) => `\t&__${r.className.slice(block.length + 2)} {\n${declLines(r.decls, 2)}\n\t}`)
		.join('\n');
	const rootDecls = root ? declLines(root.decls, 1) : '';
	return `.${block} {\n${rootDecls}${rootDecls && inner ? '\n' : ''}${inner}\n}`;
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
