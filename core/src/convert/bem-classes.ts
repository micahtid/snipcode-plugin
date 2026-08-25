/**
 * convert/bem-classes.ts: what a generated class is called.
 *
 * Both the dedup pass in convert/bem.ts and the base-class factoring in convert/bem-factor.ts
 * create classes. They must name them the same way from the same per-tag counters, or the two
 * would collide. The rule shape and the naming live here so there is one answer.
 */

/** One generated class and the declarations it carries. */
export interface ClassRule {
	className: string;
	decls: Array<[string, string]>;
	isRoot: boolean;
}

/** A fresh `block__tag-n` class, numbered per tag so names stay readable. */
export function uniqueElementClass(block: string, tag: string, counters: Map<string, number>): string {
	const n = (counters.get(tag) ?? 0) + 1;
	counters.set(tag, n);
	return `${block}__${sanitize(tag)}-${n}`;
}

/** The first author class token on the root, or its tag name, as the block base. */
export function firstClassOrTag(el: Element): string {
	const first = Array.from(el.classList)[0];
	return first ?? el.tagName.toLowerCase();
}

/**
 * Lowercase, hyphenate, and trim a token for a class name. A leading digit gains an underscore,
 * because a class selector cannot start with an unescaped digit. A hashed css-in-js class like
 * `15kfc` would emit `.15kfc`, which the browser silently ignores, leaving the snip unstyled.
 * `._15kfc` is valid.
 */
export function sanitize(name: string): string {
	const base = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return /^[0-9]/.test(base) ? `_${base}` : base;
}
