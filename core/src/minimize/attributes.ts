/**
 * minimize/attributes.ts: dropping data attributes no selector matches.
 *
 * Runs last in minimize, on the markup rather than the css. A framework leaves scope and
 * instrumentation attributes on every element that nothing styles.
 *
 * Safe by construction: an attribute no selector matches is inert, so removing it cannot move
 * a pixel. Scoped to data-* names, so aria-* and every functional attribute survive. The
 * data-snip-state and data-snip-pseudo markers survive on the same merit, with no special
 * case. The referenced-name scan errs toward keeping.
 */

/**
 * Removes every `data-*` attribute the shipped stylesheet never references from the markup.
 * Deterministic and formatting-preserving: a pure string transform that edits only open tags.
 *
 * @returns the markup with dead data attributes removed
 */
export function stripUnreferencedDataAttributes(html: string, css: string): string {
	if (!html.includes('data-')) return html;
	const referenced = referencedAttributeNames(css);
	return html.replace(OPEN_TAG, (tag) => stripDeadDataAttrs(tag, referenced));
}

/**
 * An open or self-closing start tag, from `<name` to its matching `>`. A double-quoted value
 * is spanned as a unit so a `>` inside it does not end the tag early. The emitter always
 * double-quotes, so no single-quoted or unquoted value needs handling here. Comments, the
 * doctype, and closing tags do not start with a letter, so they are left alone.
 */
const OPEN_TAG = /<[a-zA-Z][a-zA-Z0-9-]*(?:[^>"]|"[^"]*")*>/g;

/**
 * The attribute names any selector in the stylesheet references, lowercased. Collected from
 * every `[name` that opens an attribute selector. Over-collection is safe, because a `[` that
 * is actually inside a value or a data uri only adds a spurious name to the kept set, so no
 * referenced attribute is ever dropped.
 */
function referencedAttributeNames(css: string): Set<string> {
	const names = new Set<string>();
	for (const m of css.matchAll(/\[\s*([A-Za-z_][\w-]*)/g)) names.add(m[1]!.toLowerCase());
	return names;
}

/**
 * Removes each `data-*` attribute in one start tag whose name the stylesheet never references,
 * leaving every referenced attribute and every non-data attribute in place. Attribute values
 * are double-quoted and their inner quotes escaped, so `="[^"]*"` matches a value exactly.
 */
function stripDeadDataAttrs(tag: string, referenced: Set<string>): string {
	return tag.replace(/\s+([a-zA-Z_][\w-]*)="[^"]*"/g, (whole, name: string) => {
		const lower = name.toLowerCase();
		return lower.startsWith('data-') && !referenced.has(lower) ? '' : whole;
	});
}
