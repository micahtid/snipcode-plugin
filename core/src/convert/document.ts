/**
 * convert/document.ts: what every emitter returns, and how it becomes a file.
 *
 * Runs during the convert phase. Holds the output type each emitter produces, the
 * @font-face and @keyframes block they all share, the attribute escaping they all use, and
 * the composition step that turns markup plus a stylesheet into a standalone document.
 *
 * It is deliberately not one of the emitters. Every emitter imports from here, so putting
 * any format's logic in this file would make the other formats depend on that one.
 */
import type { Captured } from '../types';

/** The emitted html + the stylesheet text that must accompany it. */
export interface HtmlOutput {
	html: string;
	css: string;
}

/**
 * Builds the @font-face + @keyframes stylesheet block shared by every emitter.
 * These at-rules cannot be expressed inline or as utility classes.
 *
 * @param captured - reads fonts + keyframes
 */
export function atRulesCss(captured: Captured): string {
	const parts: string[] = [];
	for (const font of captured.fonts) parts.push(fontFaceText(font));
	for (const kf of captured.keyframes) parts.push(`@keyframes ${kf.name} {\n${kf.rules}\n}`);
	return parts.join('\n\n');
}

/**
 * The standalone document's base reset. Only the document-edge margin a user-agent
 * adds to <body> (8px) is zeroed, so the snip sits flush at the origin the way a
 * pasted component should, rather than shoved in by phantom margin it never authored.
 * Deliberately minimal: no box-sizing or typography reset, which would change how the
 * baked styles render. The snip's own margins/padding are baked inline and untouched.
 */
const BASE_RESET = 'html, body { margin: 0; padding: 0; }';

/**
 * Composes a single self-contained html document from the markup and its stylesheet.
 * Emits a valid standalone document, with doctype, charset, and head/body, so the artifact does
 * not depend on the origin and renders identically wherever it is pasted. This is what
 * renders standalone, and what the grader screenshots.
 *
 * @param html - the inline-styled markup
 * @param css - the accompanying @font-face / @keyframes block, which may be empty
 */
export function composeDocument(html: string, css: string): string {
	const sheet = [BASE_RESET, css.trim()].filter(Boolean).join('\n\n');
	return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<style>\n${sheet}\n</style>\n</head>\n<body>\n${html}\n</body>\n</html>`;
}

/**
 * Escapes the characters that are unsafe inside a double-quoted html attribute value:
 * `&` so an existing entity is not doubled or a stray ampersand re-read as one, `"` so the
 * value cannot close its own quote, and `<` so a value can never be mistaken for a tag by a
 * lenient parser. Shared by every emitter that hand-writes an attribute rather than letting
 * the serializer do it, so all of them agree on one escape set.
 *
 * @param value - the raw attribute value
 */
export function escapeHtmlAttr(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Serialize one @font-face with its family, src, and all descriptors. */
function fontFaceText(font: Captured['fonts'][number]): string {
	const descriptors = Object.entries(font.descriptors)
		.map(([k, v]) => `\t${k}: ${v};`)
		.join('\n');
	return `@font-face {\n\tfont-family: "${font.family}";\n\tsrc: ${font.src};${descriptors ? '\n' + descriptors : ''}\n}`;
}
