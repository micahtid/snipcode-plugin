/**
 * reconcile/features/urls.ts: relative url() rewriting, shared by the handlers that need it.
 *
 * A snip is pasted somewhere other than the page it came from, so any `url(logo.png)` in a
 * baked value would resolve against the wrong document. Both the effects handler (masks,
 * filters, clip paths) and the images handler (backgrounds) rewrite those to absolute, and
 * they did it with their own copy of the same function.
 */

/** Matches one `url(...)` and captures its optional quote and its target. */
const URL_IN_VALUE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** Targets that already resolve on their own: inline data, blobs, absolute urls, fragments. */
const ALREADY_RESOLVED = /^(data:|blob:|https?:|#)/i;

/**
 * Rewrites every relative url() in a css value to absolute against `base`.
 *
 * A target that already resolves is returned untouched, so `clip-path: url(#mask)` keeps
 * pointing at the in-document fragment it names.
 *
 * @param value - the css value, which may hold several url()s
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
