/**
 * convert/document.ts: what every emitter returns, and how it becomes a file.
 *
 * Runs during convert. Holds the output type each emitter produces, the @font-face and
 * @keyframes block they share, the attribute escaping they share, and the step that turns
 * markup plus a stylesheet into a standalone document.
 *
 * Deliberately not an emitter itself. Every emitter imports from here, so any format's logic
 * placed in this file would make the other formats depend on that one.
 */
import type { Captured } from '../types';

/** The emitted html + the stylesheet text that must accompany it. */
export interface HtmlOutput {
	html: string;
	css: string;
}

/** The @font-face + @keyframes block. These at-rules cannot be inline or utility classes. */
export function atRulesCss(captured: Captured): string {
	const parts: string[] = [];
	for (const font of captured.fonts) parts.push(fontFaceText(font));
	for (const kf of captured.keyframes) parts.push(`@keyframes ${kf.name} {\n${kf.rules}\n}`);
	return parts.join('\n\n');
}

/**
 * The standalone document's base reset. It zeroes only the 8px document-edge margin a ua puts
 * on <body>. The snip then sits flush at the origin rather than shoved in by margin it never
 * authored. No box-sizing or typography reset, which would change how the baked styles render.
 */
const BASE_RESET = 'html, body { margin: 0; padding: 0; }';

/**
 * Composes the self-contained html document: doctype, charset, head, and body, so the
 * artifact depends on no origin and renders the same wherever it is pasted.
 *
 * @param css - the accompanying @font-face / @keyframes block, which may be empty
 */
export function composeDocument(html: string, css: string): string {
	const sheet = [BASE_RESET, css.trim()].filter(Boolean).join('\n\n');
	return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<style>\n${sheet}\n</style>\n</head>\n<body>\n${html}\n</body>\n</html>`;
}

/**
 * Escapes what is unsafe inside a double-quoted attribute value. `&` so an entity is not
 * doubled, `"` so the value cannot close its own quote, `<` so a lenient parser cannot read it
 * as a tag. Shared, so every hand-written attribute uses one escape set.
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
