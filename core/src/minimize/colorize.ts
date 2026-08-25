/**
 * minimize/colorize.ts: short hex colors and a sane pill radius.
 *
 * Runs last in minimize, as a plain string transform. rgb() and rgba() become hex, with a
 * canvas 2d context as the authority, so the result is the engine's own canonical form and no
 * color math lives here. Wide-gamut notations keep their space and lose only float noise, and
 * a radius the engine saturated to 2.12676e+37rem becomes 9999px.
 *
 * On text, and after format, because a cssom round-trip would re-serialize a hex back to rgb()
 * and undo the pass. Two boundaries keep it paint-exact. Quoted strings and url() spans are
 * skipped, so an rgba( inside content is never read as a color. And a color is rewritten only
 * when a delimiter follows, since a bare hex against the next token glues into one bad word.
 */

/** A length in a border radius at or beyond this magnitude saturates the corner; clamp it. */
const RADIUS_SATURATION = 100000;

/**
 * Rewrites rgb()/rgba() to hex, trims float noise from a wide-gamut color, and clamps a
 * saturating border radius to `9999px`. Graceful by contract: no canvas context, or a function
 * the context does not accept, leaves the input exactly as it was.
 */
export function colorizeCss(css: string): string {
	if (!css.trim()) return css;
	const ctx = colorContext();
	if (!ctx) return css;
	// Strings and url() spans are consumed whole first, so color-looking text inside one is
	// never read as a color. A computed color function holds no nested paren, so [^)]* ends it.
	const recolored = css.replace(COLOR_OR_PROTECTED, (match, offset: number, whole: string) => {
		if (/^(?:oklab|oklch|lab|lch|color)\(/i.test(match)) return trimColorComponents(match); // Wide-gamut, so keep the space and trim the noise.
		if (!/^rgba?\(/i.test(match)) return match; // Protected string or url span, so leave it verbatim.
		const converted = colorize(match, ctx);
		// The function's `)` was a delimiter and a hex has none. So where the color abutted a
		// name char, as tailwind packs gradient stops, a space goes back in. Otherwise two
		// already-separate tokens glue into one invalid hash.
		if (converted[0] === '#') {
			const next = whole[offset + match.length];
			if (next !== undefined && NAME_CHAR.test(next)) return `${converted} `;
		}
		return converted;
	});
	return clampSaturatingRadii(recolored);
}

/**
 * A quoted string, a url() span, an rgb()/rgba() function, or a wide-gamut function with only
 * numeric arguments, in that priority. Strings and urls come first so their contents are
 * swallowed before a color inside them can match. The wide-gamut branch rejects a nested
 * paren, leaving a relative-color or calc() argument untouched.
 */
const COLOR_OR_PROTECTED = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\burl\((?:[^)"']|"[^"]*"|'[^']*')*\)|rgba?\([^)]*\)|\b(?:oklab|oklch|lab|lch|color)\([^()]*\)/gi;

/**
 * Trims each numeric component of a wide-gamut color to four decimals, dropping the float
 * noise a computed round-trip leaves. Four places is finer than a 24-bit channel resolves, so
 * the pixel is identical, and the color space is untouched so no gamut is clamped.
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
 * Clamps a saturated border radius to a plain `9999px`. Anything at or beyond
 * RADIUS_SATURATION renders as a full corner on any real box, and so does 9999px, so the swap
 * is paint-neutral. Only the border-radius family, and only a magnitude no design reaches.
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
 * One rgb()/rgba() rewritten to hex, or unchanged when the context will not take it as a
 * color. The canvas context is the authority: assigning to fillStyle yields the engine's
 * canonical spelling, which becomes the shortest hex when opaque and an eight-digit hex when
 * not. Same pixels either way.
 */
function colorize(fn: string, ctx: CanvasRenderingContext2D): string {
	// Relative-color syntax resolves against another color, and the [^)]* match can clip one
	// whose base is a var(), so any from-color is left exactly as written.
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
 * An rgba() match as #rrggbbaa, dropping the alpha byte when fully opaque. That byte is
 * round(a*255), exactly how the engine quantizes alpha to 8 bits, so the pixel is identical.
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
