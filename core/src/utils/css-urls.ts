/**
 * utils/css-urls.ts: relative url() rewriting, shared by every phase that needs it.
 *
 * A snip is pasted somewhere other than the page it came from. Any `url(logo.png)` in a baked
 * value or a @font-face src would resolve against the wrong document. Capture, resolve, and
 * reconcile each had their own copy of this rewrite; there is one now.
 */

/** Matches one `url(...)` and captures its optional quote and its target. */
const URL_IN_VALUE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** Targets that already resolve on their own: inline data, blobs, absolute urls, fragments. */
const ALREADY_RESOLVED = /^(data:|blob:|https?:|#)/i;

/**
 * Rewrites every relative url() in a css value to absolute against `base`. A target that
 * already resolves is untouched, so `clip-path: url(#mask)` keeps its fragment. A `local()`
 * source is never a url(), which is what makes this safe on a font src.
 *
 * @param warnings - optional sink for a url that will not resolve; omit it for silence
 */
export function absolutizeUrls(value: string, base: string, warnings?: string[], source = 'urls'): string {
	return value.replace(URL_IN_VALUE, (match, quote: string, url: string) => {
		if (ALREADY_RESOLVED.test(url)) return match;
		try {
			return `url(${quote}${new URL(url, base).href}${quote})`;
		} catch {
			warnings?.push(`${source}: could not resolve url ${url}`);
			return match;
		}
	});
}
