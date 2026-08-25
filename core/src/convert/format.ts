/**
 * convert/format.ts: pretty-printing the markup and the stylesheet.
 *
 * Runs in convert, for the html-shaped formats only; jsx and vue self-indent. Indentation must
 * never move a pixel, so it reflows only where that is provably render-neutral: between block
 * boxes, where whitespace collapses to nothing. Inline children, mixed text, whitespace-sensitive
 * tags, and the handler-injected nodes all stay verbatim.
 *
 * The stylesheet takes one declaration per line, which css ignores, and the reconcile-injected
 * pseudo <style> is lifted into the head sheet so all css sits in one place.
 *
 * The part a reader would not guess: the reflow decision needs each element's display and
 * white-space. html carries those inline, the class-based formats carry them in the stylesheet,
 * so the css is read too. Without it, bem markup looks all-block and subtrees collapse to a line.
 */
import type { OutputFormat } from '../types';
import { isInjected } from '../reconcile/match';
import { composeDocument, escapeHtmlAttr } from './document';
import { splitTopLevel } from '../utils/css-split';
import { parseCss } from '../utils/css-rules';

/** Html5 void elements: no closing tag, no children. */
const VOID_TAGS = new Set([
	'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
	'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * Inline-level tags whose surrounding whitespace renders. A static allowlist, because
 * getComputedStyle is unreliable on the detached parse tree. Anything unlisted, custom
 * elements included, counts as block.
 */
const INLINE_TAGS = new Set([
	'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'del', 'em',
	'i', 'ins', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub',
	'sup', 'time', 'u', 'var', 'wbr', 'button', 'img', 'input', 'select', 'textarea',
	'label', 'output', 'big', 'tt', 'font', 'picture', 'audio', 'video', 'object', 'svg',
]);

/** Tags whose inner whitespace is significant, so their content is emitted verbatim. */
const WS_SENSITIVE = new Set(['pre', 'textarea', 'code', 'script', 'style', 'svg']);

/** Computed white-space values that preserve whitespace, so text must stay verbatim. */
const PRESERVED_WS = new Set(['pre', 'pre-wrap', 'pre-line', 'break-spaces']);

/** The html-shaped output formats the formatter applies to, since jsx and vue self-indent. */
const HTML_SHAPED = new Set<OutputFormat>(['html', 'tailwind', 'bem-css']);

/** A bare css identifier that needs no escaping, so a class is safe to use as a selector verbatim. */
const BARE_IDENT = /^-?[A-Za-z_][\w-]*$/;

/** The resting display + white-space a flat class rule declares, for reflow decisions. */
interface ClassStyle {
	display?: string;
	whiteSpace?: string;
}

/** Whether a format emits html-shaped markup that the formatter should indent. */
export function isHtmlShaped(format: OutputFormat): boolean {
	return HTML_SHAPED.has(format);
}

/**
 * Assembles the self-contained document for an html-shaped format: lift the reconcile-injected
 * pseudo <style> into the head stylesheet, pretty-print both, and compose them. Render-neutral
 * throughout. `warnings` is appended to on a markup parse failure.
 */
export function assembleHtmlDocument(html: string, css: string, warnings: string[]): { html: string; css: string; document: string } {
	// One parse feeds every step below, which mutate that document in place. A failure here is
	// the case where each step would have bailed anyway, so all of them are skipped.
	let doc: Document;
	try {
		doc = new DOMParser().parseFromString(html, 'text/html');
	} catch {
		warnings.push('format: markup unparseable, left unformatted');
		return { html, css: formatCss(css).trim(), document: composeDocument(html, formatCss(css).trim()) };
	}

	const liftedCss = liftEmbeddedStyles(doc);
	// Re-key the lifted pseudo and state rules onto the host element's class where that class
	// is unique, so the output reads `.date-field::placeholder` rather than
	// `[data-snip-pseudo="0"]::placeholder`.
	const keyedPseudo = keyMarkersToClasses(doc, liftedCss, 'data-snip-pseudo');
	const keyedCss = keyMarkersToClasses(doc, keyedPseudo, 'data-snip-state');
	const formattedHtml = formatHtmlMarkup(doc, css, warnings);
	// The pseudo rules already arrive one declaration per line from features/pseudo.ts, so they
	// are appended after the class rules without re-parsing, which keeps them verbatim.
	const mergedCss = [formatCss(css).trim(), keyedCss.trim()].filter(Boolean).join('\n\n');
	return { html: formattedHtml, css: mergedCss, document: composeDocument(formattedHtml, mergedCss) };
}

/**
 * Lifts every reconcile-injected <style> out of the parsed markup, which is mutated in place,
 * and returns its css. The pseudo handler appends one inside the clone, so without this the
 * output carries css both before the markup and after it.
 */
function liftEmbeddedStyles(doc: Document): string {
	const styles = Array.from(doc.body.querySelectorAll('style'));
	if (styles.length === 0) return '';
	const css = styles.map((s) => s.textContent ?? '').filter((t) => t.trim()).join('\n\n');
	for (const style of styles) style.remove();
	return css;
}

/**
 * Re-keys lifted rules from a numeric marker to the host element's class, where that class
 * identifies exactly one element, dropping the marker from the markup as it goes. So
 * `[data-snip-state="0"]:hover [data-snip-state="1"]` becomes `.btn:hover .icon`.
 *
 * Every reference is replaced, so a selector naming one marker twice is fully rewritten. An
 * element whose class is shared, absent, or not a bare identifier keeps its marker, so a rule
 * can never leak onto a sibling. Render-neutral: a unique class matches the same element at the
 * same specificity as the attribute selector.
 */
function keyMarkersToClasses(doc: Document, css: string, attr: string): string {
	if (!css.trim()) return css;
	const marked = Array.from(doc.body.querySelectorAll(`[${attr}]`));
	if (marked.length === 0) return css;

	// A class identifies a single element when it is borne by exactly one element.
	const classCounts = new Map<string, number>();
	for (const el of doc.body.querySelectorAll('[class]')) {
		for (const name of el.classList) classCounts.set(name, (classCounts.get(name) ?? 0) + 1);
	}

	let out = css;
	for (const el of marked) {
		const id = el.getAttribute(attr);
		if (id === null) continue;
		const unique = Array.from(el.classList).find((name) => classCounts.get(name) === 1 && BARE_IDENT.test(name));
		if (!unique) continue; // Shared, unnamed, or unsafe class: keep the numeric marker
		// Literal global replace keeps the regex-special `["]` characters intact.
		out = out.split(`[${attr}="${id}"]`).join(`.${unique}`);
		el.removeAttribute(attr);
	}
	return out;
}

/**
 * Pretty-prints emitted html markup, indenting only where it is render-neutral. `css` is read
 * for class-based display and is empty for html; `warnings` is appended to when the markup
 * holds no element, after which it is re-serialized unformatted.
 */
function formatHtmlMarkup(doc: Document, css: string, warnings: string[]): string {
	const roots = Array.from(doc.body.children);
	if (roots.length === 0) {
		warnings.push('format: markup unparseable, left unformatted');
		return doc.body.innerHTML;
	}
	const classStyle = classStyleMap(css);
	return roots.map((el) => formatElement(el, 0, classStyle)).join('\n');
}

/**
 * Pretty-prints a stylesheet with one declaration per line and a blank line between rules,
 * which css does not care about. It re-parses via the cssom, as clean.ts does, so the engine
 * rather than a regex handles @font-face and the rest. Declarations are split from the rule's
 * own serialized text, so shorthands survive exactly.
 */
export function formatCss(css: string): string {
	if (!css.trim()) return css;
	const sheet = parseCss(css);
	if (!sheet) return css;
	return Array.from(sheet.cssRules).map((rule) => formatCssRule(rule, 0)).join('\n\n');
}

/** Serialize one css rule with each declaration on its own indented line. */
function formatCssRule(rule: CSSRule, depth: number): string {
	const pad = '\t'.repeat(depth);
	if (rule instanceof CSSStyleRule) {
		return `${pad}${rule.selectorText} {\n${declarationLines(rule.style.cssText, depth + 1)}\n${pad}}`;
	}
	if (rule instanceof CSSFontFaceRule) {
		return `${pad}@font-face {\n${declarationLines(rule.style.cssText, depth + 1)}\n${pad}}`;
	}
	if (rule instanceof CSSKeyframeRule) {
		return `${pad}${rule.keyText} {\n${declarationLines(rule.style.cssText, depth + 1)}\n${pad}}`;
	}
	if (rule instanceof CSSKeyframesRule) {
		const frames = Array.from(rule.cssRules).map((frame) => formatCssRule(frame, depth + 1)).join('\n');
		return `${pad}@keyframes ${rule.name} {\n${frames}\n${pad}}`;
	}
	if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
		const cond = rule instanceof CSSMediaRule ? `@media ${rule.conditionText}` : `@supports ${rule.conditionText}`;
		const inner = Array.from(rule.cssRules).map((child) => formatCssRule(child, depth + 1)).join('\n\n');
		return `${pad}${cond} {\n${inner}\n${pad}}`;
	}
	// Any other at-rule is handled by shape, not by name, so none is left on one line. Braceless
	// (@import, @charset, @layer name list): emitted as-is. Grouping (@container, @layer block,
	// @scope): recursed under its prelude, like @media above. Declaration-bearing (@property,
	// @counter-style, @page): its body split one per line. Every branch is render-neutral.
	const brace = rule.cssText.indexOf('{');
	if (brace === -1) return `${pad}${rule.cssText}`;
	const prelude = rule.cssText.slice(0, brace).trim();
	if ('cssRules' in rule) {
		const inner = Array.from((rule as CSSGroupingRule).cssRules).map((child) => formatCssRule(child, depth + 1)).join('\n\n');
		return `${pad}${prelude} {\n${inner}\n${pad}}`;
	}
	const body = rule.cssText.slice(brace + 1, rule.cssText.lastIndexOf('}'));
	return `${pad}${prelude} {\n${declarationLines(body, depth + 1)}\n${pad}}`;
}

/**
 * Splits a serialized declaration block into one indented line each. The shared top-level scan
 * does the cutting, so a `;` inside a url() or a quoted string never splits a declaration.
 * Each segment is emitted verbatim, so a descriptor body with no colon survives.
 */
function declarationLines(block: string, depth: number): string {
	const pad = '\t'.repeat(depth);
	return splitTopLevel(block, ';')
		.map((decl) => decl.trim())
		.filter(Boolean)
		.map((decl) => `${pad}${decl};`)
		.join('\n');
}

/**
 * Maps each class to its resting display and white-space, read from the emitted stylesheet.
 * Only a flat single-class rule counts, which skips @font-face, @keyframes, and the :hover
 * rules, so a resting style is never confused with a state rule. The html format has no class
 * rules and yields an empty map, falling back to inline styles.
 */
function classStyleMap(css: string): Map<string, ClassStyle> {
	const map = new Map<string, ClassStyle>();
	const ruleRe = /\.([A-Za-z_][-\w]*)\s*\{([^{}]*)\}/g;
	let rule: RegExpExecArray | null;
	while ((rule = ruleRe.exec(css))) {
		const className = rule[1];
		const body = rule[2];
		if (!className || body === undefined) continue;
		const entry = map.get(className) ?? {};
		const display = /(?:^|;)\s*display\s*:\s*([^;]+)/i.exec(body);
		if (display?.[1]) entry.display = display[1].trim().toLowerCase();
		const whiteSpace = /(?:^|;)\s*white-space\s*:\s*([^;]+)/i.exec(body);
		if (whiteSpace?.[1]) entry.whiteSpace = whiteSpace[1].trim().toLowerCase();
		map.set(className, entry);
	}
	return map;
}

/** Recursively serialize an element with one reflowable child per indented line. */
function formatElement(el: Element, depth: number, classStyle: Map<string, ClassStyle>): string {
	const pad = '\t'.repeat(depth);
	const tag = el.tagName.toLowerCase();
	const open = `<${tag}${attrs(el)}>`;

	// Void elements have no close tag and no children.
	if (VOID_TAGS.has(tag)) return `${pad}${open}`;
	if (el.childNodes.length === 0) return `${pad}${open}</${tag}>`;

	// A block whose only content is text: the trimmed text takes its own line, since a block
	// trims its edge whitespace anyway. Inline and white-space-preserving elements do not.
	if (isTextOnlyBlock(el, classStyle)) {
		return `${pad}${open}\n${pad}\t${(el.textContent ?? '').trim()}\n${pad}</${tag}>`;
	}

	// Not reflowable: inline content, mixed text, or a whitespace-sensitive tag. One verbatim
	// line, so no rendered whitespace can shift.
	if (!isReflowable(el, classStyle)) return `${pad}${open}${el.innerHTML}</${tag}>`;

	// Reflowable: all-block children, and whitespace between block boxes renders nothing.
	const childLines = Array.from(el.children).map((child) => formatElement(child, depth + 1, classStyle));
	return `${pad}${open}\n${childLines.join('\n')}\n${pad}</${tag}>`;
}

/**
 * Whether an element is a block box whose only content is significant text, so that text can
 * move to its own line. False for inline, white-space-preserving, or whitespace-sensitive
 * elements, and for anything with an element child.
 */
function isTextOnlyBlock(el: Element, classStyle: Map<string, ClassStyle>): boolean {
	if (WS_SENSITIVE.has(el.tagName.toLowerCase())) return false;
	if (isInline(el, classStyle) || preservesWhitespace(el, classStyle)) return false;
	let hasText = false;
	for (const node of Array.from(el.childNodes)) {
		if (node.nodeType === Node.ELEMENT_NODE) return false;
		if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '') hasText = true;
	}
	return hasText;
}

/**
 * Whether putting each child of `el` on its own line cannot shift rendering. True only where
 * the children are all block-level with no significant text.
 */
function isReflowable(el: Element, classStyle: Map<string, ClassStyle>): boolean {
	if (WS_SENSITIVE.has(el.tagName.toLowerCase())) return false;
	// A flex or grid container blockifies its children and drops the whitespace-only text
	// between them, so each child can take a line whatever its own display says. Outside one,
	// an inline child's surrounding whitespace renders, which forces the verbatim path.
	const itemsBlockified = establishesFlexOrGrid(el, classStyle);
	let hasElementChild = false;
	for (const node of Array.from(el.childNodes)) {
		if (node.nodeType === Node.TEXT_NODE) {
			if ((node.textContent ?? '').trim() !== '') return false; // significant text: keep inline
		} else if (node.nodeType === Node.ELEMENT_NODE) {
			const child = node as Element;
			// Injected style/svg nodes sit outside the inline flow: a <style> renders
			// nothing, and the icons sprite is absolute and zero-size.
			if (isInjected(child)) continue;
			if (!itemsBlockified && isInline(child, classStyle)) return false;
			hasElementChild = true;
		}
	}
	return hasElementChild;
}

/**
 * One resting style property, lowercased: the inline-style value for html, else the first of
 * the element's classes the stylesheet declares one for, else empty. Routing display and
 * white-space through one reader lets the same reflow logic serve both format shapes.
 */
function restingValue(el: Element, prop: string, classStyle: Map<string, ClassStyle>, pick: (s: ClassStyle) => string | undefined): string {
	const inline = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(el.getAttribute('style') ?? '');
	if (inline?.[1]) return inline[1].trim().toLowerCase();
	for (const className of Array.from(el.classList)) {
		const value = pick(classStyle.get(className) ?? {});
		if (value) return value;
	}
	return '';
}

/** Whether an element's effective display makes it a flex or grid container. */
function establishesFlexOrGrid(el: Element, classStyle: Map<string, ClassStyle>): boolean {
	const display = restingValue(el, 'display', classStyle, (s) => s.display);
	return display === 'flex' || display === 'grid' || display === 'inline-flex' || display === 'inline-grid';
}

/** Whether an element's effective white-space preserves whitespace, so text is significant. */
function preservesWhitespace(el: Element, classStyle: Map<string, ClassStyle>): boolean {
	return PRESERVED_WS.has(restingValue(el, 'white-space', classStyle, (s) => s.whiteSpace));
}

/**
 * Whether an element is inline-level: the static allowlist, then a one-way refinement that
 * only ever downgrades. An effective display of inline* makes an otherwise-block tag inline,
 * which covers the one realistic regression, an author display:inline on a div. With no
 * display available, the allowlist alone decides.
 */
function isInline(el: Element, classStyle: Map<string, ClassStyle>): boolean {
	if (INLINE_TAGS.has(el.tagName.toLowerCase())) return true;
	return restingValue(el, 'display', classStyle, (s) => s.display).startsWith('inline');
}

/** Build the attribute string for an open tag, escaping like a serializer. See escapeHtmlAttr. */
function attrs(el: Element): string {
	const parts: string[] = [];
	for (const attr of Array.from(el.attributes)) {
		parts.push(`${attr.name}="${escapeHtmlAttr(attr.value)}"`);
	}
	return parts.length ? ' ' + parts.join(' ') : '';
}
