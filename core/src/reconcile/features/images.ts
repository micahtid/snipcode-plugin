/**
 * features/images.ts: pinning responsive images and absolutizing background urls.
 *
 * srcset and <picture> pick a source from viewport and dpr at render time, so once reparented
 * the browser may pick a different one or none. Each <img> is pinned to the currentSrc the
 * browser actually resolved at the captured viewport, and srcset, sizes, and <source> are
 * dropped so it renders deterministically.
 *
 * Background urls are usually relative to the source page and 404 when pasted, so they are
 * absolutized. No fetching happens here; resolve/inline.ts does the embedding.
 */
import type { Captured } from '../../types';
import { absolutizeUrls } from './urls';

/**
 * Pins responsive images and absolutizes background-image urls.
 *
 * @param captured - clone + bakedStyles are mutated in place
 */
export function apply(captured: Captured): Captured {
	const base = document.baseURI || location.href;

	// Pin <img> to its rendered source, pairing clone imgs to live originals by order.
	const originalImgs = Array.from(captured.root.querySelectorAll('img'));
	const cloneImgs = Array.from(captured.clone.querySelectorAll('img'));
	if (originalImgs.length === cloneImgs.length) {
		for (let i = 0; i < cloneImgs.length; i++) {
			const orig = originalImgs[i];
			const cl = cloneImgs[i];
			if (!orig || !cl) continue;
			const resolved = orig.currentSrc || orig.src;
			// Don't pin a placeholder over a real source: when a lazy image never loaded
			// its real src on the live page (no loader ran), currentSrc is still the 1x1
			// spacer, but cloneElement already promoted the clone's src from data-src. Keep
			// that promoted real src rather than overwriting it with the spacer.
			if (resolved && !(isPlaceholder(resolved) && !isPlaceholder(cl.getAttribute('src') ?? ''))) {
				cl.setAttribute('src', toAbsolute(resolved, base) ?? resolved);
				// Drop responsive selectors so the pinned src is what renders.
				cl.removeAttribute('srcset');
				cl.removeAttribute('sizes');
			}
		}
	}

	// Inside <picture>, <source>s override <img src>, so remove them and the pinned
	// img src wins. The img was already pinned above.
	for (const picture of Array.from(captured.clone.querySelectorAll('picture'))) {
		for (const source of Array.from(picture.querySelectorAll('source'))) source.remove();
	}

	// Absolutize background-image url()s in the baked styles.
	for (const [clone, baked] of captured.bakedStyles) {
		for (const prop of ['background-image', 'background']) {
			const value = baked.get(prop);
			if (!value || !value.includes('url(')) continue;
			const rewritten = absolutizeUrls(value, base, captured.warnings, 'images');
			if (rewritten !== value) {
				baked.set(prop, rewritten);
				try {
					(clone as HTMLElement).style.setProperty(prop, rewritten);
				} catch {
					// Invalid for this element, so skip it.
				}
			}
		}
	}

	return captured;
}


/** The empty/spacer srcs a lazy-loader shows before swapping in the real image. */
function isPlaceholder(src: string): boolean {
	return !src || src.startsWith('data:image') || src.includes('1x1') || src.includes('placeholder');
}

/** Resolve a possibly-relative url against the document base, returning null if unparseable. */
function toAbsolute(url: string, base: string): string | null {
	try {
		return new URL(url, base).href;
	} catch {
		return null;
	}
}
