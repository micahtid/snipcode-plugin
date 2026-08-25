/**
 * convert/assets.ts: lifting inline svgs, images, and fonts into their own files.
 *
 * Runs last in convert, on the assembled document. The self-contained form renders as one file
 * but reads badly: a 30-line icon sits in the middle of the markup and an embedded font dwarfs
 * the stylesheet. Each is lifted out and referenced. The caller keeps the single-file document
 * too, so this is delivery shape only.
 *
 * One fidelity catch. An svg loaded through <img> no longer inherits the page's color. Each
 * icon's currentColor is resolved by laying the document out in a hidden iframe and reading
 * the computed color. The computed box carries onto the replacement <img> so it lands where
 * the svg did. An svg out of flow, or a sprite whose <use> points outside itself, cannot be
 * reproduced that way and stays inline. What lifts is faithful; what would not stays put.
 */
import type { AssetFile } from '../types';
import { escapeHtmlAttr } from './document';
import { parseDeclarations } from '../utils/css-split';
import { withProbeFrame } from '../reconcile/frame';

/** The color an icon falls back to when nothing in its ancestry sets one. */
const DEFAULT_COLOR = '#000000';

/**
 * An svg composing through references cannot be trusted to paint the same once detached. A
 * mask, a filter, a <use> of defs, or a <foreignObject> keeps it inline. Simple shape-and-path
 * icons carry no such construct and lift faithfully.
 */
const COMPOSES_VIA_REFERENCE = /<(?:use|mask|filter|foreignObject)\b/i;

/** Data-uri images referenced by an attribute, img src or use href, or by css url(). */
const DATA_IMG_ATTR = /(\b(?:src|href)\s*=\s*)(["'])(data:image\/[^"']+)\2/gi;
const DATA_IMG_URL = /url\(\s*(["']?)(data:image\/[^"')]+)\1\s*\)/gi;

/**
 * Splits an assembled document into index.html plus one file per inline svg and data-uri
 * image, deduped by content. Any failure returns the document whole as the only file.
 *
 * @param warnings - appended to if the split is skipped
 * @returns index.html first, then the extracted files in encounter order
 */
export function splitAssets(documentHtml: string, warnings: string[]): AssetFile[] {
	try {
		const assets: AssetFile[] = [];
		const fileByContent = new Map<string, string>(); // Identical content reuses one file
		let svgCount = 0;
		let imageCount = 0;
		let fontCount = 0;

		const boxes = resolveSvgBoxes(documentHtml);
		let svgIndex = 0;
		let html = extractSvgs(documentHtml, (svg) => {
			const box = boxes[svgIndex++];
			// A sprite pointing at a fragment defined outside itself loses its target once
			// detached, so keep it inline.
			if (referencesExternalFragment(svg)) return svg;
			// An svg out of normal flow, a decorative graphic bleeding past its container,
			// needs its whole positioning context, which an in-flow <img> cannot carry.
			if (box && (box.position !== 'static' || box.transform !== 'none')) return svg;
			// An svg composing cross-references renders through its host document, and detached
			// into a standalone <img> those break or paint differently.
			if (COMPOSES_VIA_REFERENCE.test(svg)) return svg;
			const file = bakeColor(ensureXmlns(svg), box?.color ?? DEFAULT_COLOR);
			const name = register(assets, fileByContent, file, () => `icon-${++svgCount}.svg`, 'svg', { text: file });
			return buildImgTag(svg, name, box);
		});

		html = extractDataUris(html, (dataUrl) =>
			register(assets, fileByContent, dataUrl, () => `image-${++imageCount}.${mimeExtension(dataUrl)}`, 'image', { dataUrl }),
		);

		// Fonts are the bulk of the stylesheet's bytes. Lifting each to its own file shrinks
		// the css a reader sees to the @font-face rule plus a short relative url.
		html = extractFontUris(html, (dataUrl, ext) =>
			register(assets, fileByContent, dataUrl, () => `font-${++fontCount}.${ext}`, 'font', { dataUrl }),
		);

		return [{ name: 'index.html', language: 'html', text: html }, ...assets];
	} catch (err) {
		warnings.push(`asset split skipped: ${(err as Error).message}`);
		return [{ name: 'index.html', language: 'html', text: documentHtml }];
	}
}

/** Records an asset, deduped by content, and returns the filename to reference it by. */
function register(
	assets: AssetFile[],
	fileByContent: Map<string, string>,
	content: string,
	makeName: () => string,
	language: AssetFile['language'],
	payload: Pick<AssetFile, 'text' | 'dataUrl'>,
): string {
	const existing = fileByContent.get(content);
	if (existing) return existing;
	const name = makeName();
	fileByContent.set(content, name);
	assets.push({ name, language, ...payload });
	return name;
}

// ---------------------------------------------------------------------------
// Inline svg extraction
// ---------------------------------------------------------------------------

/**
 * Replaces each top-level inline svg with what `replace` returns, leaving the surrounding
 * markup and its formatting alone. A nested svg travels inside its outermost parent.
 */
function extractSvgs(html: string, replace: (svg: string) => string): string {
	let result = '';
	let i = 0;
	let start: number;
	while ((start = nextSvgStart(html, i)) !== -1) {
		const end = matchingSvgEnd(html, start);
		if (end === -1) break; // Unbalanced, so leave the remainder verbatim
		result += html.slice(i, start) + replace(html.slice(start, end));
		i = end;
	}
	return result + html.slice(i);
}

/** The index of the next real `<svg` tag at or after `from`, skipping `<svgfoo`-style false hits. */
function nextSvgStart(html: string, from: number): number {
	let at = html.indexOf('<svg', from);
	while (at !== -1 && !isSvgTagStart(html, at)) at = html.indexOf('<svg', at + 4);
	return at;
}

/** The index just past the `</svg>` that closes the svg opening at `start`, or -1 if unbalanced. */
function matchingSvgEnd(html: string, start: number): number {
	let depth = 0;
	let i = start;
	while (i < html.length) {
		const close = html.indexOf('</svg>', i);
		if (close === -1) return -1;
		let open = html.indexOf('<svg', i);
		while (open !== -1 && open < close && !isSvgTagStart(html, open)) open = html.indexOf('<svg', open + 4);
		if (open !== -1 && open < close) {
			depth++;
			i = open + 4;
		} else {
			depth--;
			i = close + 6;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** True when `<svg` at `pos` begins a tag, meaning the next char ends the name, rather than a longer word. */
function isSvgTagStart(html: string, pos: number): boolean {
	const next = html[pos + 4];
	return next === undefined || next === '>' || next === '/' || /\s/.test(next);
}

/** Replaces currentColor, in any case, with a concrete color so the detached icon keeps it. */
function bakeColor(svg: string, color: string): string {
	return svg.replace(/currentcolor/gi, color);
}

/** True when the svg references a fragment by #id, for example a sprite <use href="#id">, that it does not define itself. */
function referencesExternalFragment(svg: string): boolean {
	const ids = (re: RegExp) => [...svg.matchAll(re)].map((m) => m[1]).filter((id): id is string => id !== undefined);
	const referenced = ids(/href\s*=\s*["']#([\w:.-]+)["']/gi);
	if (referenced.length === 0) return false;
	const defined = new Set(ids(/\sid\s*=\s*["']([\w:.-]+)["']/gi));
	return referenced.some((id) => !defined.has(id));
}

/** Adds the svg namespace to the root tag if absent, so the file renders standalone. */
function ensureXmlns(svg: string): string {
	const tagEnd = svg.indexOf('>');
	if (tagEnd === -1 || /\sxmlns\s*=/.test(svg.slice(0, tagEnd))) return svg;
	return `<svg xmlns="http://www.w3.org/2000/svg"${svg.slice(4)}`;
}

/** Builds the <img> that replaces an inline svg, carrying its box styles and label. */
function buildImgTag(svg: string, name: string, box: SvgBox | undefined): string {
	const el = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg');
	if (!el) return `<img src="${name}" alt="">`;
	const style = imgStyle(el, box);
	const alt = el.getAttribute('aria-label') ?? el.querySelector('title')?.textContent ?? '';
	const hidden = el.getAttribute('aria-hidden') === 'true' ? ' aria-hidden="true"' : '';
	return `<img src="${name}"${style ? ` style="${escapeHtmlAttr(style)}"` : ''}${hidden} alt="${escapeHtmlAttr(alt)}">`;
}

/** Props an extracted <img> must not copy: paint is baked in, and the box supplies the rest. */
const BAKED_IMG_PROPS = new Set(['fill', 'stroke', 'color', 'width', 'height', 'display', 'vertical-align']);

/**
 * The box styles the <img> needs to land where the inline svg did, minus the now-baked paint.
 * An svg's size, display, and baseline can come from an attribute, an inline style, or a class
 * rule. Only the computed box captures all three, so that is the ground truth. Other box props
 * authored inline, a margin say, are kept as written, and display and vertical-align are
 * emitted only when they deviate from the <img> defaults.
 */
function imgStyle(el: Element, box: SvgBox | undefined): string {
	const decls: string[] = [];
	// The shared top-level split keeps a `;` inside a data uri with its value, so a data-uri
	// background survives the copy intact.
	for (const { prop, value } of parseDeclarations(el.getAttribute('style') ?? '')) {
		const name = prop.toLowerCase();
		// Paint is baked into the file. Size, display, and baseline come from the computed box.
		if (!name || BAKED_IMG_PROPS.has(name)) continue;
		decls.push(`${name}: ${value}`);
	}
	if (box) {
		if (box.display !== 'inline') decls.push(`display: ${box.display}`);
		if (box.verticalAlign !== 'baseline') decls.push(`vertical-align: ${box.verticalAlign}`);
		if (box.width !== 'auto') decls.push(`width: ${box.width}`);
		if (box.height !== 'auto') decls.push(`height: ${box.height}`);
	}
	return decls.join('; ');
}

// ---------------------------------------------------------------------------
// Data-uri image extraction
// ---------------------------------------------------------------------------

/** Replaces each data:image uri, in src/href attrs and css url(), with the filename `replace` returns. */
function extractDataUris(html: string, replace: (dataUrl: string) => string): string {
	return html
		.replace(DATA_IMG_ATTR, (_m, prefix: string, quote: string, dataUrl: string) => `${prefix}${quote}${replace(dataUrl)}${quote}`)
		.replace(DATA_IMG_URL, (_m, quote: string, dataUrl: string) => `url(${quote}${replace(dataUrl)}${quote})`);
}

/** The file extension for a data:image uri (svg+xml -> svg, jpeg -> jpg). */
function mimeExtension(dataUrl: string): string {
	const subtype = (/^data:image\/([a-z0-9.+-]+)/i.exec(dataUrl)?.[1] ?? 'png').toLowerCase();
	if (subtype === 'svg+xml') return 'svg';
	if (subtype === 'jpeg') return 'jpg';
	return subtype.replace(/[^a-z0-9]/g, '') || 'png';
}

// ---------------------------------------------------------------------------
// Data-uri font extraction
// ---------------------------------------------------------------------------

/**
 * A css url() carrying a data uri, plus the optional format() hint that follows it in a
 * @font-face src. The groups are the opening quote, the uri, the format() span to preserve,
 * and the hint token. Image extraction ran first, so what is left is a font or a non-image
 * asset the mime check below filters.
 */
const DATA_FONT_URL = /url\(\s*(["']?)(data:[^"')]+)\1\s*\)(\s*format\(\s*["']?([\w+-]+)["']?\s*\))?/gi;

/** The extension for a font mime type: one reliable signal a data uri carries a font. */
const FONT_MIME_EXT: Record<string, string> = {
	'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/truetype': 'ttf',
	'font/otf': 'otf', 'font/opentype': 'otf', 'font/sfnt': 'ttf',
	'application/font-woff2': 'woff2', 'application/font-woff': 'woff', 'application/x-font-woff': 'woff',
	'application/font-sfnt': 'ttf', 'application/x-font-ttf': 'ttf', 'application/x-font-truetype': 'ttf',
	'application/x-font-opentype': 'otf', 'application/vnd.ms-fontobject': 'eot',
};

/** The extension for a format() hint, the fallback when the mime is generic (octet-stream). */
const FONT_HINT_EXT: Record<string, string> = { woff2: 'woff2', woff: 'woff', truetype: 'ttf', opentype: 'otf', 'embedded-opentype': 'eot', svg: 'svg' };

/** The extension for a font's magic bytes, the ground truth beneath any declared mime. */
const FONT_SIGNATURE_EXT: Record<string, string> = { wOF2: 'woff2', wOFF: 'woff', OTTO: 'otf', true: 'ttf', typ1: 'ttf', ttcf: 'ttc', '\x00\x01\x00\x00': 'ttf' };

/**
 * Replaces each data-uri font in a css url() with the filename `replace` returns for the
 * resolved extension, preserving the format() hint. A non-font uri is left untouched.
 */
function extractFontUris(html: string, replace: (dataUrl: string, ext: string) => string): string {
	return html.replace(DATA_FONT_URL, (whole, quote: string, dataUrl: string, formatSpan: string | undefined, hint: string | undefined) => {
		const mime = (/^data:([^;,]*)/i.exec(dataUrl)?.[1] ?? '').toLowerCase();
		const ext = fontExtension(dataUrl, mime, hint);
		if (!ext) return whole; // Not a font data uri, so leave it as written.
		return `url(${quote}${replace(dataUrl, ext)}${quote})${formatSpan ?? ''}`;
	});
}

/**
 * The extension for a font data uri, or null when it is not a font. The magic bytes are ground
 * truth and are read first, so a woff2 served as octet-stream is still recognized. The mime
 * and then the format() hint are fallbacks for a container whose header has no signature.
 */
function fontExtension(dataUrl: string, mime: string, hint: string | undefined): string | null {
	const bySignature = fontSignatureExt(dataUrl);
	if (bySignature) return bySignature;
	if (FONT_MIME_EXT[mime]) return FONT_MIME_EXT[mime];
	if (/^font\//.test(mime)) return 'woff2'; // A font/* subtype we do not enumerate, so woff2 is the modern default.
	const hinted = hint ? FONT_HINT_EXT[hint.toLowerCase()] : undefined;
	if (hinted && (mime === 'application/octet-stream' || mime === 'binary/octet-stream' || mime === '')) return hinted;
	return null;
}

/** The extension implied by a base64 data uri's first four decoded bytes, or null. */
function fontSignatureExt(dataUrl: string): string | null {
	const head = /;base64,([A-Za-z0-9+/]{8})/.exec(dataUrl)?.[1];
	if (!head) return null;
	try {
		return FONT_SIGNATURE_EXT[atob(head).slice(0, 4)] ?? null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The computed box a top-level svg occupies, the ground truth the replacement <img> matches. */
interface SvgBox {
	color: string; // Resolved currentColor, baked into the detached file
	display: string;
	verticalAlign: string;
	width: string; // Used width in px, or 'auto'
	height: string;
	position: string; // Non-static or a transform means the svg is out of normal flow
	transform: string;
}

/**
 * The computed box each top-level svg renders with, in document order, from the document laid
 * out in a hidden iframe. getComputedStyle resolves color, size, display, and baseline however
 * they were set, so the replacement <img> matches in every output format. Fewer entries come
 * back when the document will not lay out, and callers fall back to defaults.
 */
function resolveSvgBoxes(documentHtml: string): SvgBox[] {
	const boxes: SvgBox[] = [];
	try {
		// Sandboxed, because this frame is handed the artifact's own markup to lay out.
		withProbeFrame((doc, win) => {
			doc.open();
			doc.write(documentHtml);
			doc.close();
			for (const svg of doc.querySelectorAll('svg')) {
				if (!isTopLevelSvg(svg)) continue;
				const cs = win.getComputedStyle(svg);
				boxes.push({ color: cs.color || DEFAULT_COLOR, display: cs.display, verticalAlign: cs.verticalAlign, width: cs.width, height: cs.height, position: cs.position, transform: cs.transform });
			}
		}, true);
	} catch {
		// Layout unavailable, so callers fall back to defaults.
	}
	return boxes;
}

/** True when no ancestor of `svg` is itself an svg, so it is one we extract. */
function isTopLevelSvg(svg: Element): boolean {
	for (let p = svg.parentElement; p; p = p.parentElement) if (p.tagName.toLowerCase() === 'svg') return false;
	return true;
}

