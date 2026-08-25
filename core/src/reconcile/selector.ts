/**
 * reconcile/selector.ts: a small compound and combinator selector parser.
 *
 * Used by the state handlers. Re-anchoring a rule like `.nav > .btn:hover` means taking it
 * apart: which compound is the subject, which carry a dynamic pseudo, and how they are joined.
 *
 * A regex cannot do it safely: a selector nests parens, brackets, and strings, any of which
 * can hide a comma, a combinator, or a colon. So this walks the string tracking depth and
 * quotes. Structural only, validating nothing past balanced delimiters, because the caller's
 * live element.matches() is the real arbiter. Unbalanced input throws.
 */

/** A combinator between two compounds: descendant as a space, child, next-sibling, subsequent-sibling. */
export type Combinator = ' ' | '>' | '+' | '~';

/**
 * The interactive pseudo-classes absent from a resting capture, so a rule using one is
 * silently dropped by the resting cascade. The closed set states.ts reproduces. Form-state
 * pseudos are excluded: they reflect dom state that is already captured at rest.
 */
export const DYNAMIC_PSEUDOS = new Set([':hover', ':focus', ':focus-visible', ':focus-within', ':active']);

/** Legacy single-colon spellings of pseudo-elements, normalized to `::` on parse. */
const LEGACY_PSEUDO_ELEMENTS = new Set([':before', ':after', ':first-line', ':first-letter']);

/** element.matches that swallows the SyntaxError an unsupported selector throws. */
export function safeMatches(el: Element, selector: string): boolean {
	try {
		return el.matches(selector);
	} catch {
		return false;
	}
}

/**
 * The functional pseudo-classes whose argument is itself a selector list, which a framework
 * can bury an interactive pseudo inside. Tailwind v4 compiles `group-hover:` to
 * `:is(:where(.group):hover *)`, so finding the element to force means descending into these.
 */
const FORGIVING_FUNCTIONAL = new Set([':is', ':where', ':not', ':has']);

/** One compound selector: a run of simple selectors with no combinator between them. */
export interface Compound {
	/** The compound's source text, verbatim. */
	raw: string;
	/**
	 * The compound reduced to its structural simple selectors, meaning tag, class, id,
	 * attribute, and structural pseudo-classes like `:nth-child`, with the dynamic
	 * interactive pseudo-classes and any pseudo-element removed. This is the form
	 * matched against a live element to bind the compound. An empty string means the
	 * compound has no structural part, such as a bare `:hover`, which matches any element.
	 */
	structural: string;
	/** The dynamic interactive pseudo-classes at this compound's top level, e.g. `[':hover']`. */
	dynamicPseudos: string[];
	/** The pseudo-element this compound targets, normalized to `::name`, or '' if none. */
	pseudoElement: string;
}

/** One complex selector: compounds left-to-right, joined by combinators. */
export interface Complex {
	/** The compounds, in source (left-to-right) order. The last is the subject. */
	compounds: Compound[];
	/** combinators[i] joins compounds[i] to compounds[i + 1]. Its length is compounds.length - 1. */
	combinators: Combinator[];
}

/** Whitespace characters that separate tokens at the top level of a selector. */
const WS = new Set([' ', '\t', '\n', '\r', '\f']);

/** The explicit combinator characters. */
const COMBINATOR_CHARS = new Set(['>', '+', '~']);

/** Identifier characters, unescaped, in a css name, class, id, tag, or pseudo name. */
function isIdentChar(ch: string): boolean {
	return /[A-Za-z0-9_-]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}

/**
 * Cheap pre-filter: whether a selector mentions a dynamic pseudo at all, so the full parse is
 * skipped for the great majority of rules. A false positive, the token inside a string, costs
 * a parse that finds nothing and never a wrong result.
 */
export function containsDynamicPseudo(selector: string): boolean {
	return /:(?:hover|focus|focus-visible|focus-within|active)\b/.test(selector);
}

/**
 * Parses a selector list: top-level commas, then each branch into compounds and combinators.
 *
 * @throws SyntaxError on unbalanced parens, brackets, or quotes
 */
export function parseSelectorList(selector: string): Complex[] {
	return splitSelectorTopLevel(selector, ',').map(parseComplex);
}

/** One element to force a state on: its structural selector plus the pseudos to force there. */
export interface TriggerBearer {
	/** The bearer compound's structural selector, matched against a live element to force it.
	 * An empty string (a bare `:hover`) matches any element. */
	structural: string;
	/** The dynamic interactive pseudo-classes to force on that element, colon form, e.g. `[':hover']`. */
	dynamicPseudos: string[];
}

/**
 * Every element a state rule asks to force, as (structural selector, pseudos) pairs.
 *
 * Measurement needs only the element carrying the pseudo, never the subject relationship.
 * Force that element, read the subtree, and the engine resolves the descendant, group-hover,
 * and sibling effects itself. Much smaller than re-anchoring the whole combinator chain.
 *
 * A top-level pseudo (`.btn:hover`) yields its compound's structural part. One buried in a
 * functional pseudo (`:is(:where(.group):hover *)`) is found by descending into the argument
 * and taking the inner bearer. The grammar the framework encoded is stepped past, not decoded.
 *
 * @throws SyntaxError on unbalanced parens, brackets, or quotes
 */
export function findTriggerBearers(selector: string): TriggerBearer[] {
	const bearers: TriggerBearer[] = [];
	for (const complex of parseSelectorList(selector)) {
		for (const compound of complex.compounds) collectBearers(compound.raw, bearers);
	}
	return bearers;
}

/**
 * The bearers one compound carries: its own top-level dynamic pseudos, plus any found by
 * descending into a functional pseudo. A functional pseudo holding a dynamic one is dropped
 * from the structural part, since it would never match at rest; a purely structural
 * `:where(.group)` is kept.
 *
 * @param out - the accumulating bearer list, appended in place
 */
function collectBearers(compoundText: string, out: TriggerBearer[]): void {
	const structural: string[] = [];
	const dynamic: string[] = [];
	for (const piece of tokenizeSimpleSelectors(compoundText)) {
		if (piece.startsWith('::')) continue; // Pseudo-element, so irrelevant to which element to force.
		if (piece.startsWith(':')) {
			const name = pseudoName(piece);
			if (LEGACY_PSEUDO_ELEMENTS.has(name)) continue;
			if (DYNAMIC_PSEUDOS.has(name)) {
				dynamic.push(piece.toLowerCase());
				continue;
			}
			if (FORGIVING_FUNCTIONAL.has(name)) {
				const arg = functionalArgument(piece);
				if (arg && containsDynamicPseudo(arg)) {
					for (const inner of parseSelectorList(arg)) for (const c of inner.compounds) collectBearers(c.raw, out);
					continue; // Holds a dynamic pseudo, so it is not a rest-time structural constraint.
				}
			}
		}
		structural.push(piece);
	}
	if (dynamic.length > 0) out.push({ structural: structural.join(''), dynamicPseudos: dynamic });
}

/** The argument text of a functional pseudo piece (`:is(ARG)` -> `ARG`), or '' if none. */
function functionalArgument(piece: string): string {
	const open = piece.indexOf('(');
	const close = piece.lastIndexOf(')');
	return open !== -1 && close > open ? piece.slice(open + 1, close) : '';
}

/**
 * Parses one complex selector, with no top-level comma, into compounds and combinators.
 *
 * @throws SyntaxError on unbalanced delimiters
 */
export function parseComplex(complex: string): Complex {
	const { compoundTexts, combinators } = splitCompounds(complex);
	const compounds = compoundTexts.map(analyzeCompound);
	return { compounds, combinators };
}

/**
 * Splits a complex selector into compound texts and the combinators between them, tracking
 * depth so a combinator-looking character inside brackets or a string is never one.
 *
 * @throws SyntaxError on unbalanced delimiters
 */
function splitCompounds(s: string): { compoundTexts: string[]; combinators: Combinator[] } {
	const compoundTexts: string[] = [];
	const combinators: Combinator[] = [];
	let cur = '';
	let i = 0;
	let depth = 0;
	let quote: string | null = null;

	while (i < s.length) {
		const ch = s[i] as string;
		if (quote) {
			cur += ch;
			if (ch === quote) quote = null;
			else if (ch === '\\') { cur += s[i + 1] ?? ''; i++; }
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; cur += ch; i++; continue; }
		if (ch === '(' || ch === '[') { depth++; cur += ch; i++; continue; }
		if (ch === ')' || ch === ']') { depth--; cur += ch; i++; continue; }
		if (ch === '\\') { cur += ch + (s[i + 1] ?? ''); i += 2; continue; }

		if (depth === 0 && (WS.has(ch) || COMBINATOR_CHARS.has(ch))) {
			// A combinator boundary: consume the whole run of whitespace and at most one
			// explicit combinator. The run is a descendant combinator unless it contains an
			// explicit one, in which case that wins and any whitespace around it is just padding.
			let comb: Combinator = ' ';
			while (i < s.length) {
				const c = s[i] as string;
				if (WS.has(c)) { i++; continue; }
				if (COMBINATOR_CHARS.has(c)) { comb = c as Combinator; i++; continue; }
				break;
			}
			if (cur.trim() !== '') {
				compoundTexts.push(cur.trim());
				combinators.push(comb);
				cur = '';
			}
			continue;
		}
		cur += ch;
		i++;
	}
	if (depth !== 0 || quote) throw new SyntaxError(`unbalanced selector: ${s}`);
	if (cur.trim() !== '') compoundTexts.push(cur.trim());
	// A trailing combinator with no following compound, e.g. "a >", is dangling, so drop it.
	if (combinators.length >= compoundTexts.length) combinators.length = Math.max(0, compoundTexts.length - 1);
	return { compoundTexts, combinators };
}

/**
 * Splits a selector on one top-level delimiter, ignoring parens, brackets, and strings.
 *
 * Not splitTopLevel from utils/css-split.ts, which splits css values. This one honors backslash
 * escapes so `.hover\:bg-x` stays whole, and it trims and drops empty branches. It also throws
 * on unbalanced input, because a selector that does not parse must never be re-anchored onto
 * the wrong element. test/unit.ts pins both.
 *
 * @throws SyntaxError on unbalanced delimiters
 */
export function splitSelectorTopLevel(s: string, delim: string): string[] {
	const out: string[] = [];
	let cur = '';
	let depth = 0;
	let quote: string | null = null;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i] as string;
		if (quote) {
			cur += ch;
			if (ch === quote) quote = null;
			else if (ch === '\\') { cur += s[i + 1] ?? ''; i++; }
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
		if (ch === '(' || ch === '[') { depth++; cur += ch; continue; }
		if (ch === ')' || ch === ']') { depth--; cur += ch; continue; }
		if (ch === '\\') { cur += ch + (s[i + 1] ?? ''); i++; continue; }
		if (ch === delim && depth === 0) { out.push(cur); cur = ''; continue; }
		cur += ch;
	}
	if (depth !== 0 || quote) throw new SyntaxError(`unbalanced selector: ${s}`);
	out.push(cur);
	return out.map((t) => t.trim()).filter((t) => t !== '');
}

/**
 * Analyzes one compound into its structural part, its dynamic pseudo-classes, and any
 * pseudo-element. The structural part binds the compound to a live element; the other two are
 * what the re-anchored rule keeps once a marker replaces it.
 */
function analyzeCompound(raw: string): Compound {
	const structuralParts: string[] = [];
	const dynamicPseudos: string[] = [];
	let pseudoElement = '';

	for (const piece of tokenizeSimpleSelectors(raw)) {
		const kind = classifyPiece(piece);
		if (kind === 'pseudo-element') {
			pseudoElement += normalizePseudoElement(piece);
		} else if (kind === 'dynamic-pseudo') {
			dynamicPseudos.push(piece.toLowerCase());
		} else {
			structuralParts.push(piece);
		}
	}
	return { raw, structural: structuralParts.join(''), dynamicPseudos, pseudoElement };
}

/** Whether a simple-selector piece is a pseudo-element, a dynamic pseudo-class, or structural. */
function classifyPiece(piece: string): 'pseudo-element' | 'dynamic-pseudo' | 'structural' {
	if (piece.startsWith('::')) return 'pseudo-element';
	if (piece.startsWith(':')) {
		const name = pseudoName(piece);
		if (LEGACY_PSEUDO_ELEMENTS.has(name)) return 'pseudo-element';
		if (DYNAMIC_PSEUDOS.has(name)) return 'dynamic-pseudo';
	}
	return 'structural';
}

/** The bare `:name` of a pseudo with no arguments, lowercased, for set lookup. */
function pseudoName(piece: string): string {
	const colons = piece.startsWith('::') ? '::' : ':';
	const rest = piece.slice(colons.length);
	const paren = rest.indexOf('(');
	const name = (paren === -1 ? rest : rest.slice(0, paren)).toLowerCase();
	return `:${name}`;
}

/** Normalize a pseudo-element to its `::name` spelling, folding legacy single-colon forms. */
function normalizePseudoElement(piece: string): string {
	return piece.startsWith('::') ? piece : `:${piece}`;
}

/**
 * Splits a compound into its simple selectors, tracking depth and escapes so a delimiter
 * inside brackets or parens never starts a new piece.
 */
function tokenizeSimpleSelectors(compound: string): string[] {
	const pieces: string[] = [];
	let i = 0;
	while (i < compound.length) {
		const ch = compound[i] as string;
		if (WS.has(ch)) { i++; continue; }
		const start = i;
		if (ch === '[') {
			i = skipBalanced(compound, i, '[', ']');
		} else if (ch === ':') {
			// Pseudo-class or pseudo-element: one or two colons, an identifier, and an optional
			// balanced argument list.
			i++;
			if (compound[i] === ':') i++;
			i = readIdent(compound, i);
			if (compound[i] === '(') i = skipBalanced(compound, i, '(', ')');
		} else if (ch === '.' || ch === '#') {
			i = readIdent(compound, i + 1);
		} else if (ch === '*' || ch === '&') {
			i++;
		} else {
			// A type or tag selector, optionally namespaced (ns|tag).
			i = readIdent(compound, i);
			if (compound[i] === '|') i = readIdent(compound, i + 1);
		}
		if (i <= start) i = start + 1; // Defensive: never fail to advance.
		pieces.push(compound.slice(start, i));
	}
	return pieces;
}

/** Advance past a run of identifier characters and escapes from `i`. */
function readIdent(s: string, i: number): number {
	while (i < s.length) {
		const ch = s[i] as string;
		if (ch === '\\') { i += 2; continue; }
		if (isIdentChar(ch)) { i++; continue; }
		break;
	}
	return i;
}

/** Advance past a balanced `open`/`close` delimited run, e.g. `[...]` or `(...)`, quote-aware. */
function skipBalanced(s: string, i: number, open: string, close: string): number {
	let depth = 0;
	let quote: string | null = null;
	for (; i < s.length; i++) {
		const ch = s[i] as string;
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === '\\') i++;
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === '\\') i++;
		else if (ch === open) depth++;
		else if (ch === close) {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return i; // Unbalanced: splitCompounds/splitSelectorTopLevel already guard the whole string.
}
