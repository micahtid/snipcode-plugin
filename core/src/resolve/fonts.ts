/**
 * resolve/fonts.ts: making the snip's webfonts load from its new home.
 *
 * Runs during resolve. A @font-face src is usually relative to the source page, so it 404s
 * once the snip is pasted elsewhere; each is resolved to an absolute url.
 *
 * The face list is then narrowed to what the subtree renders. Family alone is not enough: a
 * page ships every weight and a component renders one or two, so the rest would be dead
 * downloads. Matching runs on family, weight, and style through the css font-matching
 * algorithm, so a request with no exact face keeps the one the browser substitutes.
 */
import type { Captured, FontFace } from '../types';
import { absolutizeUrls } from '../utils/css-urls';

/**
 * The pseudo-elements whose own font can differ from the host element's, mirroring what
 * features/pseudo.ts materializes. Sampling them keeps a face only a pseudo renders.
 */
const PSEUDO_ELEMENTS = ['::before', '::after', '::marker', '::placeholder', '::file-selector-button'];

/** One (weight, style) a family is rendered at somewhere in the subtree. */
interface FaceRequest {
	weight: number; // Numeric css weight (1-1000), where normal -> 400 and bold -> 700
	style: string; // 'normal' | 'italic' | 'oblique'
}

/** The css2 generic font families. A stack ending in one of these has a safe fallback. */
const GENERIC_FAMILIES = new Set([
	'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif',
	'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong',
]);

/**
 * Guarantees every baked font-family stack ends in a generic family, so an unavailable custom
 * font never drops text to Times New Roman. A stack already ending in one is untouched;
 * otherwise a generic is appended, monospace when the first family hints at it and sans-serif
 * otherwise. Runs after the standalone reconciliation baked the resolved stacks.
 *
 * @param captured - every baked font-family value is normalized in place
 */
export function appendGenericFallbacks(captured: Captured): void {
	for (const [clone, baked] of captured.bakedStyles) {
		const stack = baked.get('font-family');
		if (!stack) continue;
		const families = stack.split(',').map((f) => f.trim()).filter(Boolean);
		const last = families[families.length - 1]?.replace(/^["']|["']$/g, '').toLowerCase();
		if (!last || GENERIC_FAMILIES.has(last)) continue; // Already safe.
		const generic = /\bmono(space)?\b/i.test(stack) ? 'monospace' : 'sans-serif';
		const next = `${stack}, ${generic}`;
		baked.set('font-family', next);
		try {
			(clone as HTMLElement).style.setProperty('font-family', next);
		} catch {
			// Invalid for this element, but the baked-map entry still ships to emit.
		}
	}
}

/** Narrows captured faces to the ones the snip renders and absolutizes their src. */
export function resolveFonts(captured: Captured): void {
	const { requests, codepoints } = faceRequests(captured.root);
	const base = document.baseURI || location.href;
	const seen = new Set<string>();
	const resolved: FontFace[] = [];

	for (const font of keptFaces(captured.fonts, requests, codepoints)) {
		const src = absolutizeUrls(font.src, base);
		const key = `${normalizeFamily(font.family).toLowerCase()}|${src}|${descriptorKey(font)}`;
		if (seen.has(key)) continue; // Dedupe identical faces
		seen.add(key);
		resolved.push({ family: font.family, src, descriptors: font.descriptors });
	}
	captured.fonts = resolved;
}

/**
 * The faces to keep, in captured order. A face survives when its family renders in the subtree
 * and its weight and style are what css font-matching picks for one of that family's requests.
 *
 * unicode-range subsetting is honored, the next.js and google-fonts shape of one family split
 * across latin, latin-ext, and cyrillic files. Of the faces at the matched weight and style,
 * only those covering a codepoint the snip renders survive. A latin snip then keeps the latin
 * subset rather than an arbitrary first one that would render nothing.
 */
function keptFaces(fonts: FontFace[], requests: Map<string, FaceRequest[]>, codepoints: Set<number>): FontFace[] {
	const byFamily = new Map<string, FontFace[]>();
	for (const font of fonts) {
		const family = normalizeFamily(font.family).toLowerCase();
		let faces = byFamily.get(family);
		if (!faces) byFamily.set(family, (faces = []));
		faces.push(font);
	}

	const keep = new Set<FontFace>();
	for (const [family, faces] of byFamily) {
		const reqs = requests.get(family);
		if (!reqs) continue; // Family never renders, drop every weight
		for (const req of reqs) {
			for (const face of selectFaces(req, faces, codepoints)) keep.add(face);
		}
	}
	return fonts.filter((font) => keep.has(font));
}

/** The family, weight, and style requests plus the codepoints the live subtree renders. */
interface SubtreeFaces {
	requests: Map<string, FaceRequest[]>;
	codepoints: Set<number>;
}

/**
 * The family, weight, and style triples the live subtree renders, keyed by lowercased family,
 * plus every codepoint it renders, so unicode-range narrowing can keep the covering subsets.
 */
function faceRequests(root: Element): SubtreeFaces {
	const requests = new Map<string, FaceRequest[]>();
	const codepoints = new Set<number>();
	addCodepoints(codepoints, root.textContent ?? '');
	const record = (style: CSSStyleDeclaration) => {
		const family = normalizeFamily(style.fontFamily.split(',')[0] ?? '').toLowerCase();
		if (!family) return;
		const request: FaceRequest = { weight: normalizeWeight(style.fontWeight), style: normalizeStyle(style.fontStyle) };
		let list = requests.get(family);
		if (!list) requests.set(family, (list = []));
		if (!list.some((r) => r.weight === request.weight && r.style === request.style)) list.push(request);
	};

	for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
		record(getComputedStyle(el));
		for (const pseudo of renderedPseudos(el)) {
			const cs = getComputedStyle(el, pseudo);
			record(cs);
			const content = cs.getPropertyValue('content');
			if (content && content !== 'none' && content !== 'normal') addCodepoints(codepoints, content.replace(/^["']|["']$/g, ''));
		}
	}
	return { requests, codepoints };
}

/** Adds every codepoint of a string to the set, iterating by code point, not utf-16 unit. */
function addCodepoints(set: Set<number>, text: string): void {
	for (const ch of text) {
		const cp = ch.codePointAt(0);
		if (cp !== undefined) set.add(cp);
	}
}

/** Which pseudo-elements actually generate a box on this element, so their font renders. */
function renderedPseudos(el: Element): string[] {
	const out: string[] = [];
	for (const pseudo of ['::before', '::after'] as const) {
		const content = getComputedStyle(el, pseudo).getPropertyValue('content');
		if (content && content !== 'none' && content !== 'normal') out.push(pseudo);
	}
	if (getComputedStyle(el).display === 'list-item') out.push('::marker');
	if (el.hasAttribute('placeholder')) out.push('::placeholder');
	try {
		if (el.matches('input[type="file"]')) out.push('::file-selector-button');
	} catch {
		// Matches unsupported, so ignore.
	}
	return out.filter((pseudo) => PSEUDO_ELEMENTS.includes(pseudo));
}

/**
 * The captured faces one weight request resolves to. Faces of the requested style win, and if
 * the family has none the browser synthesizes from any weight, so all stay eligible. The css
 * algorithm then picks one weight. Every face at that weight and style whose unicode-range
 * covers a rendered codepoint is kept, since subsets partition the codepoint space.
 *
 * When no subset covers the text, an exotic repertoire or an unparseable range, the weight
 * winner is kept as a floor so the family renders rather than vanishing.
 */
function selectFaces(request: FaceRequest, faces: FontFace[], codepoints: Set<number>): FontFace[] {
	const styled = faces.filter((face) => faceStyle(face) === request.style);
	const pool = styled.length > 0 ? styled : faces;
	const index = matchWeight(request.weight, pool.map(faceWeightRange));
	if (index === -1) return [];
	const winner = pool[index];
	if (!winner) return [];
	const [wlo, whi] = faceWeightRange(winner);
	const covering = pool.filter((face) => {
		const [lo, hi] = faceWeightRange(face);
		return lo === wlo && hi === whi && faceCoversCodepoints(face, codepoints);
	});
	return covering.length > 0 ? covering : [winner];
}

/**
 * Whether a face renders any codepoint the snip shows. No unicode-range means the full
 * repertoire, so it always qualifies; otherwise one declared range must contain a rendered
 * codepoint. An empty codepoint set or an unparseable range qualifies, erring toward keeping.
 */
function faceCoversCodepoints(font: FontFace, codepoints: Set<number>): boolean {
	const descriptor = font.descriptors['unicode-range'];
	if (!descriptor) return true; // No subsetting: the face covers everything.
	if (codepoints.size === 0) return true; // Nothing to render, so do not drop on coverage.
	const ranges = parseUnicodeRange(descriptor);
	if (ranges.length === 0) return true; // Unparseable, so keep rather than wrongly drop.
	for (const cp of codepoints) {
		for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
	}
	return false;
}

/**
 * Parses a unicode-range descriptor into [lo, hi] pairs: the single, range, and wildcard
 * forms. A token it cannot read is skipped rather than failing the whole descriptor.
 */
function parseUnicodeRange(descriptor: string): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (const token of descriptor.split(',')) {
		const t = token.trim().replace(/^u\+/i, '');
		if (!t) continue;
		if (t.includes('?')) {
			const lo = parseInt(t.replace(/\?/g, '0'), 16);
			const hi = parseInt(t.replace(/\?/g, 'f'), 16);
			if (Number.isFinite(lo) && Number.isFinite(hi)) out.push([lo, hi]);
		} else if (t.includes('-')) {
			const [a, b] = t.split('-');
			const lo = parseInt(a ?? '', 16);
			const hi = parseInt(b ?? '', 16);
			if (Number.isFinite(lo) && Number.isFinite(hi)) out.push([lo, hi]);
		} else {
			const cp = parseInt(t, 16);
			if (Number.isFinite(cp)) out.push([cp, cp]);
		}
	}
	return out;
}

/**
 * Indexes the face a weight resolves to under the css-fonts-4 weight-matching
 * algorithm, generalized to weight ranges. Returns -1 only for an empty pool.
 */
function matchWeight(desired: number, ranges: Array<[number, number]>): number {
	if (ranges.length === 0) return -1;
	// A face whose declared range covers the request is an exact match.
	const exact = ranges.findIndex(([lo, hi]) => desired >= lo && desired <= hi);
	if (exact !== -1) return exact;
	// Otherwise rank by the spec's directional preference, scoring each face by the range
	// boundary nearest the request.
	const boundary = ([lo, hi]: [number, number]) => (desired < lo ? lo : hi);
	for (const weight of weightSearchOrder(desired, ranges.map(boundary))) {
		const index = ranges.findIndex((range) => boundary(range) === weight);
		if (index !== -1) return index;
	}
	return 0; // Unreachable for a non-empty pool, so keep the first face defensively
}

/**
 * The order css font-matching prefers weights in when no face matches exactly. The 400-500
 * band searches up to 500, then down, then heavier. Below 400 prefers lighter, above 500
 * prefers heavier.
 */
function weightSearchOrder(desired: number, weights: number[]): number[] {
	const unique = [...new Set(weights)];
	const lighter = unique.filter((w) => w < desired).sort((a, b) => b - a);
	const heavier = unique.filter((w) => w > desired).sort((a, b) => a - b);
	if (desired >= 400 && desired <= 500) {
		return [...heavier.filter((w) => w <= 500), ...lighter, ...heavier.filter((w) => w > 500)];
	}
	if (desired < 400) return [...lighter, ...heavier];
	return [...heavier, ...lighter];
}

/** A face's [min, max] weight from its font-weight descriptor, either a single value or a range. */
export function faceWeightRange(font: FontFace): [number, number] {
	const parts = (font.descriptors['font-weight'] ?? '400').trim().split(/\s+/).map(normalizeWeight);
	const lo = parts[0] ?? 400;
	const hi = parts[1] ?? lo;
	return [Math.min(lo, hi), Math.max(lo, hi)];
}

/** A face's style from its font-style descriptor, collapsed to the matching keyword. */
function faceStyle(font: FontFace): string {
	return normalizeStyle(font.descriptors['font-style'] ?? 'normal');
}

/** Resolve a css font-weight token to its numeric value (normal -> 400, bold -> 700). */
function normalizeWeight(raw: string): number {
	const value = raw.trim().toLowerCase();
	if (value === 'normal') return 400;
	if (value === 'bold') return 700;
	const numeric = parseInt(value, 10);
	return Number.isFinite(numeric) ? numeric : 400;
}

/** Collapse a css font-style value, which may carry an oblique angle, to its keyword. */
function normalizeStyle(raw: string): string {
	const value = raw.trim().toLowerCase();
	if (value.startsWith('italic')) return 'italic';
	if (value.startsWith('oblique')) return 'oblique';
	return 'normal';
}

/** Strip quotes and trim a font-family token, dropping the size noise a `font` shorthand adds. */
export function normalizeFamily(raw: string): string {
	return raw
		.replace(/^["']|["']$/g, '')
		.replace(/^\s*(?:\d+(?:\.\d+)?(?:px|rem|em|%)?\/?\S*\s+)+/, '') // Drop leading size/line-height from `font` shorthand
		.trim();
}

/** A stable key over the weight/style/unicode-range descriptors for dedupe. */
function descriptorKey(font: FontFace): string {
	return Object.entries(font.descriptors)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}:${v}`)
		.join(';');
}
