/**
 * minimize/attributes.ts: dropping data attributes no selector matches.
 *
 * Runs last in minimize, on the markup rather than the css. A framework leaves scope and
 * instrumentation attributes on every element that nothing styles.
 *
 * Safe by construction: an attribute no selector matches is inert, so removing it cannot move
 * a pixel. Scoped to data-* names, so aria-* and every functional attribute survive, and the
 * snip's own markers survive on the same merit with no special case.
 */

/**
 * Removes every `data-*` attribute the shipped stylesheet never references. A pure string
 * transform over open tags, so formatting is preserved.
 *
 * @returns the markup with dead data attributes removed
 */
export function stripUnreferencedDataAttributes(html: string, css: string): string {
	if (!html.includes('data-')) return html;
	const referenced = referencedAttributeNames(css);
	return html.replace(OPEN_TAG, (tag) => stripDeadDataAttrs(tag, referenced));
}

/**
 * A start tag, from `<name` to its matching `>`. A double-quoted value is spanned whole so a
 * `>` inside it does not end the tag early; the emitter always double-quotes. Comments, the
 * doctype, and closing tags do not start with a letter and are left alone.
 */
const OPEN_TAG = /<[a-zA-Z][a-zA-Z0-9-]*(?:[^>"]|"[^"]*")*>/g;

/**
 * The attribute names the stylesheet references, from every `[name` in it. Over-collection is
 * safe: a `[` inside a value only adds a spurious name to the kept set.
 */
function referencedAttributeNames(css: string): Set<string> {
	const names = new Set<string>();
	for (const m of css.matchAll(/\[\s*([A-Za-z_][\w-]*)/g)) names.add(m[1]!.toLowerCase());
	return names;
}

/**
 * Removes the unreferenced `data-*` attributes from one start tag. Values are double-quoted
 * with inner quotes escaped, so `="[^"]*"` matches one exactly.
 */
function stripDeadDataAttrs(tag: string, referenced: Set<string>): string {
	return tag.replace(/\s+([a-zA-Z_][\w-]*)="[^"]*"/g, (whole, name: string) => {
		const lower = name.toLowerCase();
		return lower.startsWith('data-') && !referenced.has(lower) ? '' : whole;
	});
}
