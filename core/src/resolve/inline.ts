/**
 * resolve/inline.ts: carrying the pixels with the snip.
 *
 * Runs last in resolve, after the standalone reconciliation. A snip that still points at the
 * origin breaks the moment it is pasted somewhere that cannot reach those urls. Hotlink
 * protected fonts, authenticated image cdns, or simply offline. Every referenced font and
 * image is fetched through the Host and rewritten to a data uri.
 *
 * Best effort: a fetch that fails leaves the absolute url in place rather than throwing, so
 * the snip still ships. Bounded by a resource cap so a heavy page cannot bloat the output.
 */
import type { Captured } from '../types';
import { synthesizedStyle, forEachSynthesizedDeclaration, rewriteSynthesizedDeclarations } from '../reconcile/synthesized';
import { getHost } from '../host';

/** Matches each url() token in a css value such as font src or background-image, quote-tolerant. */
const URL_IN_VALUE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** The background-carrying baked properties whose url()s are inlined. */
const BG_PROPS = ['background-image', 'background'] as const;

/** Cap on resources fetched per snip, so a gallery-heavy page cannot inline without bound. */
const MAX_RESOURCES = 48;

/** Concurrent background fetches. Keeps the snip responsive without flooding the worker. */
const FETCH_CONCURRENCY = 6;

/** Per-fetch deadline. A stalled resource is abandoned, keeping its url, rather than hanging the snip. */
const FETCH_TIMEOUT_MS = 8000;

/** A resource larger than this is left as a url reference rather than inlined, mirroring the background cap. */
const MAX_INLINE_BYTES = 3 * 1024 * 1024;

/**
 * Inlines every referenced font and image as a data uri. It collects the unique absolute urls
 * across @font-face src, img src, and baked background-image, fetches them within bounds, then
 * rewrites each reference. A url that would not fetch is left as it was.
 *
 * @param captured - clone, bakedStyles, and fonts are rewritten in place
 */
export async function inlineResources(captured: Captured): Promise<void> {
	const base = captured.page.url || document.baseURI || location.href;
	const wanted = new Set<string>();
	const add = (raw: string): void => {
		if (!raw || raw.startsWith('data:')) return;
		const abs = absolute(raw, base);
		if (abs && /^https?:/i.test(abs)) wanted.add(abs);
	};

	const imgs = collectImages(captured.clone);
	for (const font of captured.fonts) for (const u of urlsIn(font.src)) add(u);
	for (const img of imgs) add(img.getAttribute('src') ?? '');
	for (const [, baked] of captured.bakedStyles) {
		for (const prop of BG_PROPS) for (const u of urlsIn(baked.get(prop) ?? '')) add(u);
	}
	// The synthesized rules carry their own url(), a hover background or a css icon, which the
	// bakedStyles loop never sees because they live in a <style>.
	forEachSynthesizedDeclaration(captured, (decl) => { for (const u of urlsIn(decl.value)) add(u); });

	if (wanted.size === 0) return;
	const urls = [...wanted].slice(0, MAX_RESOURCES);
	if (urls.length < wanted.size) {
		captured.warnings.push(`inline: ${wanted.size - urls.length} resource(s) over the cap left as url references`);
	}

	const dataByUrl = await fetchAll(urls);
	if (dataByUrl.size === 0) {
		// Nothing inlined, so the rewrites below are no-ops. The closing guard still runs, so
		// an un-inlinable face drops to its fallback rather than shipping a dead url.
		captured.warnings.push('inline: no resources could be inlined; the snip references the origin for fonts/images');
	}

	// Rewrite @font-face src.
	for (const font of captured.fonts) font.src = rewriteUrls(font.src, base, dataByUrl);
	// Rewrite <img> src.
	for (const img of imgs) {
		const src = img.getAttribute('src');
		if (!src || src.startsWith('data:')) continue;
		const data = dataByUrl.get(absolute(src, base) ?? '');
		if (data) img.setAttribute('src', data);
	}
	// Rewrite baked background urls. The inline style mirrors the baked map.
	for (const [clone, baked] of captured.bakedStyles) {
		for (const prop of BG_PROPS) {
			const value = baked.get(prop);
			if (!value || !value.includes('url(')) continue;
			const rewritten = rewriteUrls(value, base, dataByUrl);
			if (rewritten === value) continue;
			baked.set(prop, rewritten);
			try {
				(clone as HTMLElement).style.setProperty(prop, rewritten);
			} catch {
				// Invalid for this element, but the baked-map entry still ships to emit.
			}
		}
	}

	// Only when one was actually inlined, so the synthesized <style> is not re-serialized, and
	// reformatted, in the common case that carries no url() at all.
	if (dataByUrl.size > 0 && (synthesizedStyle(captured)?.textContent ?? '').includes('url(')) {
		rewriteSynthesizedDeclarations(captured, (decl) =>
			decl.value.includes('url(') ? rewriteUrls(decl.value, base, dataByUrl) : decl.value,
		);
	}

	dropUncontainedFaces(captured);
}

/**
 * Drops any @font-face the inlining could not make self-contained, so the artifact never ships
 * a dead origin reference. Such a face cannot render once pasted away from the origin, and
 * appendGenericFallbacks has already given every stack a generic. The text falls back
 * deterministically instead of 404ing.
 *
 * The closing guard for the resource path. Whatever recovery and inlining could not carry is
 * corrected to a clean fallback rather than left to break. The standalone probe still counts
 * the family unresolved, so the loss stays visible.
 *
 * @param captured - captured.fonts is filtered in place
 */
function dropUncontainedFaces(captured: Captured): void {
	const contained = captured.fonts.filter((font) => isSelfContained(font.src));
	if (contained.length === captured.fonts.length) return;
	captured.warnings.push(
		`inline: dropped ${captured.fonts.length - contained.length} font face(s) that could not be made self-contained; their text falls back to a generic`,
	);
	captured.fonts = contained;
}

/**
 * Whether a @font-face src renders without the origin: no external url at all, or one paired
 * with an inlined data: source or a local() system fallback.
 */
function isSelfContained(src: string): boolean {
	if (!/url\(\s*['"]?https?:/i.test(src)) return true; // No external url to depend on.
	return /url\(\s*['"]?data:/i.test(src) || /\blocal\(/i.test(src);
}

/** Every <img> in the snip subtree, including the root when it is itself an image. */
function collectImages(clone: Element): HTMLImageElement[] {
	const imgs = Array.from(clone.querySelectorAll('img')) as HTMLImageElement[];
	if (clone.tagName === 'IMG') imgs.push(clone as HTMLImageElement);
	return imgs;
}

/** Fetches every url through the background broker, bounded by FETCH_CONCURRENCY. */
async function fetchAll(urls: string[]): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < urls.length) {
			const url = urls[next++];
			if (!url) continue;
			const dataUrl = await fetchData(url);
			if (dataUrl) out.set(url, dataUrl);
		}
	};
	await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, urls.length) }, worker));
	return out;
}

/**
 * Fetches one url as a data uri, null on failure or timeout. A direct page fetch first, which
 * covers same-origin and cors-enabled resources with no round-trip, then the privileged host,
 * which reaches the cross-origin and hotlink-protected ones the page cannot.
 */
async function fetchData(url: string): Promise<string | null> {
	const direct = await fetchDataDirect(url);
	if (direct) return direct;
	return fetchDataViaBackground(url);
}

/** Direct content-script fetch + encode. Null if blocked by cors, oversize, or non-2xx. */
async function fetchDataDirect(url: string): Promise<string | null> {
	try {
		const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
		if (!res.ok) return null;
		const blob = await res.blob();
		if (blob.size > MAX_INLINE_BYTES) return null;
		return await blobToDataUrl(blob);
	} catch {
		return null;
	}
}

/** Background-broker fetch, privileged. Null on failure or timeout. */
async function fetchDataViaBackground(url: string): Promise<string | null> {
	try {
		const reply = (await Promise.race([
			getHost().fetchBinary(url),
			new Promise((resolve) => setTimeout(() => resolve(null), FETCH_TIMEOUT_MS)),
		])) as { ok?: boolean; result?: { dataUrl?: string } } | null;
		return reply?.ok && reply.result?.dataUrl ? reply.result.dataUrl : null;
	} catch {
		return null;
	}
}

/** Reads a blob into a base64 data uri. */
function blobToDataUrl(blob: Blob): Promise<string | null> {
	return new Promise((resolve) => {
		const reader = new FileReader();
		reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
		reader.onerror = () => resolve(null);
		reader.readAsDataURL(blob);
	});
}

/** Every url() target inside a css value; font src may list several. */
function urlsIn(value: string): string[] {
	const out: string[] = [];
	for (const match of value.matchAll(URL_IN_VALUE)) {
		const url = match[2];
		if (url) out.push(url);
	}
	return out;
}

/** Rewrites each url() in a value to its data uri when one was fetched, else leaves it. */
function rewriteUrls(value: string, base: string, dataByUrl: Map<string, string>): string {
	return value.replace(URL_IN_VALUE, (match, quote: string, url: string) => {
		if (url.startsWith('data:')) return match;
		const data = dataByUrl.get(absolute(url, base) ?? '');
		return data ? `url(${quote}${data}${quote})` : match;
	});
}

/** Resolve a possibly-relative url against the base. Null if unparseable. */
function absolute(url: string, base: string): string | null {
	try {
		return new URL(url, base).href;
	} catch {
		return null;
	}
}
