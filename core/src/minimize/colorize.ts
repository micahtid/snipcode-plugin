/**
 * minimize/colorize.ts: short hex colors and a sane pill radius.
 *
 * Runs last in minimize, after format, as a plain string transform. Rewrites rgb() and rgba()
 * to hex using a canvas 2d context as the authority, so the result is the engine's own
 * canonical form with no color math here. Wide-gamut notations keep their color space and are
 * only trimmed of float noise. A radius the engine saturated to 2.12676e+37rem becomes 9999px.
 *
 * It runs on text, after format, because a cssom round-trip would re-serialize a hex back to
 * rgb() and undo the whole pass. Two boundaries keep it paint-exact: quoted strings and url()
 * spans are skipped, so an rgba( sequence that is content is never mistaken for a color; and a
 * color is only rewritten when a delimiter follows, since a bare hex packed against the next
 * token would glue into one invalid word.
 */

/** A length in a border radius at or beyond this magnitude saturates the corner; clamp it. */
const RADIUS_SATURATION = 100000;

/**
 * Rewrites every rgb()/rgba() color function to hex, trims the float noise from a wide-gamut
 * color's components, and clamps a saturating border radius to `9999px`. It is graceful by
 * contract, returning the input unchanged when a canvas context is unavailable, and leaving any
 * function the context does not accept as a color exactly as it was.
 *
 * @returns the stylesheet with colors canonicalized and saturating radii clamped
 */
export function colorizeCss(css: string): string {
	if (!css.trim()) return css;
	const ctx = colorContext();
	if (!ctx) return css;
	// Tokenize into quoted strings, url() spans, and color functions, in that order, so a
	// string or url is consumed as one unit and any color-looking text inside it is never
	// seen as a color. A color function never contains a nested paren in a computed value,
	// so [^)]* delimits it exactly.
	const recolored = css.replace(COLOR_OR_PROTECTED, (match, offset: number, whole: string) => {
		if (/^(?:oklab|oklch|lab|lch|color)\(/i.test(match)) return trimColorComponents(match); // Wide-gamut, so keep the space and trim the noise.
		if (!/^rgba?\(/i.test(match)) return match; // Protected string or url span, so leave it verbatim.
		const converted = colorize(match, ctx);
		// A hex has no trailing delimiter, but the color function's `)` did. When the color
		// abutted a name char with no delimiter (tailwind packs gradient stops as
		// `rgb(25, 25, 29)0px`), the two were already separate tokens, so insert a space so the
		// hex stays distinct rather than gluing into one invalid hash token.
		if (converted[0] === '#') {
			const next = whole[offset + match.length];
			if (next !== undefined && NAME_CHAR.test(next)) return `${converted} `;
		}
		return converted;
	});
	return clampSaturatingRadii(recolored);
}

/**
 * Matches, in priority order, a double-quoted string, a single-quoted string, a url() span,
 * an rgb()/rgba() color function, or a wide-gamut color function with only simple numeric
 * arguments. The string and url alternatives come first so their contents are swallowed
 * before a color function inside them can match on its own. The wide-gamut alternative rejects
 * a nested paren, so a relative-color or calc() argument is left untouched.
 */
const COLOR_OR_PROTECTED = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\burl\((?:[^)"']|"[^"]*"|'[^']*')*\)|rgba?\([^)]*\)|\b(?:oklab|oklch|lab|lch|color)\([^()]*\)/gi;

/**
 * Trims each numeric component of a wide-gamut color function to at most four decimal places,
 * removing the float noise a computed round-trip leaves. Four places is finer than a 24-bit
 * channel resolves, so the trimmed color paints the identical pixel. The color space is
 * untouched, so no gamut is clamped. Non-numeric tokens, such as a color-space keyword or an
 * angle unit, pass through.
 *
 * @param fn - a wide-gamut color function with only simple numeric arguments
 */
function trimColorComponents(fn: string): string {
	return fn.replace(/-?\d*\.\d+(?:e[+-]?\d+)?/gi, (num) => {
		const rounded = Number(Number(num).toFixed(4));
		return Number.isFinite(rounded) ? String(rounded) : num;
	});
}

/**
 * Clamps a border radius the engine rounded past the saturation point to a plain `9999px`.
 * A radius at or beyond RADIUS_SATURATION units renders as a full corner on any element a
 * real layout can produce, and `9999px` renders the identical corner, so the swap is paint-
 * neutral. Only the border-radius family is touched, and only a length token whose magnitude
 * no real design reaches, so a legitimate radius is never rewritten.
 */
function clampSaturatingRadii(css: string): string {
	return css.replace(/border(?:-[a-z]+)*-radius\s*:\s*[^;{}]+/gi, (decl) =>
		decl.replace(/(-?\d[\d.]*(?:e[+-]?\d+)?)(px|rem|em|q|pt|pc|in|cm|mm|ch|ex|vh|vw|vmin|vmax)\b/gi, (token, value: string) =>
			Math.abs(Number(value)) >= RADIUS_SATURATION ? '9999px' : token,
		),
	);
}

/** A css name-continuation code point, the set that would extend a hash token past a hex. */
const NAME_CHAR = /[-\w\u0080-\uffff]/;

/**
 * One rgb()/rgba() function rewritten to hex, or unchanged when the context does not accept
 * it as a lone color. The canvas context is the authority: assigning the function to
 * fillStyle yields the engine's canonical spelling, a #rrggbb hex for an opaque color and an
 * rgba() for a translucent one. An opaque color becomes the shortest hex and a translucent
 * one an eight-digit hex, both the same pixels the context would paint.
 */
function colorize(fn: string, ctx: CanvasRenderingContext2D): string {
	// Relative-color syntax, rgb(from ...), resolves against another color, and the [^)]* match
	// can also clip one whose base is a var(). Leave any from-color exactly as written.
	if (/\bfrom\b/i.test(fn)) return fn;
	const probe = '#000001';
	ctx.fillStyle = probe;
	ctx.fillStyle = fn;
	const canonical = ctx.fillStyle;
	if (canonical === probe) return fn; // Not a color the context accepted, so leave it.
	if (canonical.startsWith('#')) return shortHex(canonical);
	const rgba = canonical.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/i);
	if (rgba) return hex8(rgba);
	return fn; // A form the context kept as a function, so leave it.
}

/**
 * An rgba() match as #rrggbbaa, dropping the alpha byte to #rrggbb when fully opaque. The
 * alpha byte is round(a*255), which is exactly how the engine quantizes a fractional alpha
 * to 8 bits, so #rrggbbaa paints the identical pixel the rgba() would.
 */
function hex8(rgba: RegExpMatchArray): string {
	const byte = (n: number): string => Math.round(n).toString(16).padStart(2, '0');
	const [r, g, b] = [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])];
	const a = Math.round(Number(rgba[4]) * 255);
	const base = `#${byte(r)}${byte(g)}${byte(b)}`;
	return a === 255 ? shortHex(base) : `${base}${byte(a)}`;
}

/** Shortens a #rrggbb hex to #rgb when each channel is a doubled nibble. */
function shortHex(hex: string): string {
	if (hex.length === 7 && hex[1] === hex[2] && hex[3] === hex[4] && hex[5] === hex[6]) {
		return `#${hex[1]}${hex[3]}${hex[5]}`;
	}
	return hex;
}

/** A reusable 1x1 2d context for canonicalizing colors, or null when canvas is unavailable. */
let sharedContext: CanvasRenderingContext2D | null | undefined;
function colorContext(): CanvasRenderingContext2D | null {
	if (sharedContext !== undefined) return sharedContext;
	try {
		sharedContext = document.createElement('canvas').getContext('2d');
	} catch {
		sharedContext = null;
	}
	return sharedContext;
}
