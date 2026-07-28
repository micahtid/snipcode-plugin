/**
 * utils/css-split.ts: one quote and paren aware splitter for css text.
 *
 * Nearly every phase cuts a css string at its top-level separators, and each cut has the same
 * trap: the separator also appears inside url(data:...;base64,...), inside a function such as
 * cubic-bezier(0.4, 0, 0.2, 1), and inside a quoted family or attribute value. The scan lived
 * in a dozen near-identical copies, so it lives here once.
 *
 * Pure string work, no dom and no cssom, so both build graphs can import it.
 */

/** How a split treats bracket spans, on top of the always tracked parens and quotes. */
export interface SplitOptions {
	/** Also treat `[` and `]` as a nesting span, for selector text. Default false. */
	brackets?: boolean;
}

/**
 * Splits `text` at every separator that sits at the top level, meaning outside every
 * paren span, outside every bracket span when `brackets` is set, and outside every
 * quoted string. Separators are dropped, not kept with either side. Segments are
 * returned verbatim, untrimmed and including empties, so callers decide what an empty
 * segment means for their own grammar.
 *
 * @returns the segments, always at least one
 */
export function splitTopLevel(text: string, separator: string | RegExp, options: SplitOptions = {}): string[] {
	const isSeparator = typeof separator === 'string'
		? (ch: string): boolean => ch === separator
		: (ch: string): boolean => separator.test(ch);
	const out: string[] = [];
	let depth = 0;
	let quote = '';
	let buf = '';
	for (const ch of text) {
		if (quote) {
			// Inside a string every character is literal, including a separator.
			if (ch === quote) quote = '';
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === '(' || (options.brackets && ch === '[')) {
			depth++;
		} else if (ch === ')' || (options.brackets && ch === ']')) {
			if (depth > 0) depth--;
		} else if (depth === 0 && isSeparator(ch)) {
			out.push(buf);
			buf = '';
			continue;
		}
		buf += ch;
	}
	out.push(buf);
	return out;
}

/**
 * Splits a comma separated value list at its top level commas, trimming each entry and
 * dropping empty ones. This is how the engine reads a layered value such as a
 * transition or a shadow list, where a trailing or doubled comma contributes no layer.
 */
export function splitCommaList(value: string): string[] {
	return splitTopLevel(value, ',')
		.map((part) => part.trim())
		.filter((part) => part !== '');
}

/** One declaration parsed out of a css declaration block or an inline style string. */
export interface Declaration {
	/** The property name, trimmed, in its original case. */
	prop: string;
	/** The value text, trimmed, with any `!important` priority still attached. */
	value: string;
	/** The whole `prop: value` text, trimmed, priority included, for faithful re-emission. */
	decl: string;
}

/**
 * Splits a serialized declaration block or inline style string into its declarations.
 * Cuts on top level semicolons only, then on each segment's first top level colon, so a
 * `;` or `:` inside a `url(data:image/png;base64,...)`, inside any other function, or
 * inside a quoted string stays part of the value. A segment carrying no top level colon
 * is not a declaration and is dropped.
 *
 * Nothing is normalized here: the property keeps its case and the value keeps its
 * priority, so a caller that re-emits the text reproduces it exactly, and a caller that
 * wants a lowercased property or a priority stripped value asks for it explicitly. See
 * stripImportant.
 */
export function parseDeclarations(cssText: string): Declaration[] {
	const out: Declaration[] = [];
	for (const segment of splitTopLevel(cssText, ';')) {
		const decl = segment.trim();
		if (!decl) continue;
		// The first top level colon separates the property from the value. A colon inside a
		// following url() or function belongs to the value, so the scan stops at the first one.
		const colon = splitTopLevel(decl, ':')[0];
		if (colon === undefined || colon.length === decl.length) continue; // No top level colon: not a declaration.
		out.push({
			prop: colon.trim(),
			value: decl.slice(colon.length + 1).trim(),
			decl,
		});
	}
	return out;
}

/** A value with any trailing `!important` priority removed. */
export function stripImportant(value: string): string {
	return value.replace(/\s*!\s*important\s*$/i, '').trim();
}
