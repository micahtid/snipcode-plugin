/**
 * utils/color.ts: the color parsing, serializing, and perceptual math every phase shares.
 *
 * There was no home for this, so each phase needing a hex parser wrote its own. Domain-specific
 * color work stays with its domain: the tailwind palette in convert/tw-palette.ts,
 * normalizeColor in inspect/schema/shared.ts, the canvas sampling in minimize/colorize.ts.
 */

/** Parsed rgb channels 0-255, plus alpha 0-1. */
export interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

/** A color in Oklab: lightness plus the two opponent axes. */
export interface Oklab {
	L: number;
	a: number;
	b: number;
}

/** Parses rgb()/rgba() in either comma or slash notation, null when the value is not one. */
export function parseRgba(value: string): Rgba | null {
	const m = value.trim().match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i);
	if (!m) return null;
	const alphaRaw = m[4] === undefined ? 1 : parseFloat(m[4]);
	const alpha = m[5] === '%' ? alphaRaw / 100 : alphaRaw;
	return { r: parseFloat(m[1]!), g: parseFloat(m[2]!), b: parseFloat(m[3]!), a: isNaN(alpha) ? 1 : alpha };
}

/** Serializes rgb channels as #rrggbb, clamping to range and dropping any alpha. */
export function rgbToHex(rgb: { r: number; g: number; b: number }): string {
	return '#' + [rgb.r, rgb.g, rgb.b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('');
}

/** Parses a #rrggbb hex string to rgb, null when it is not one. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
	const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
	if (!m) return null;
	return { r: parseInt(m[1]!, 16), g: parseInt(m[2]!, 16), b: parseInt(m[3]!, 16) };
}

/**
 * Whether a normalized color paints nothing: only the two spellings a computed style produces.
 * A zero alpha in another notation is not matched, and reconcile/standalone.ts, the one caller
 * that needs the broader test, has its own.
 */
export function isTransparentColor(value: string): boolean {
	return value === 'transparent' || value === 'rgba(0, 0, 0, 0)';
}

/** sRGB channel [0-255] to linear-light [0-1]. */
function srgbToLinear(c: number): number {
	const s = c / 255;
	return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/**
 * RGB to Oklab, the perceptually uniform model clustering measures distance in. Clustering a
 * palette needs a distance matching what an eye calls the same color, which sRGB does not give.
 */
export function rgbToOklab(r: number, g: number, b: number): Oklab {
	const lr = srgbToLinear(r);
	const lg = srgbToLinear(g);
	const lb = srgbToLinear(b);
	const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
	const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
	const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
	return {
		L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
		a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
		b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
	};
}

/** Euclidean distance in Oklab space. */
export function oklabDistance(a: Oklab, b: Oklab): number {
	return Math.sqrt((a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2);
}
