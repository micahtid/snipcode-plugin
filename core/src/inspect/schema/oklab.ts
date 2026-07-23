/**
 * inspect/schema/oklab.ts: the perceptual color math the palette clustering measures with
 *
 * Pipeline position: inspect, page-scoped. See inspect/schema/extract.ts for the whole pass.
 * Reads from DOM: nothing. Pure math.
 * Writes to: nothing.
 *
 * Why this exists: clustering a page's palette needs a distance that matches what an eye
 * calls "the same color", which sRGB does not give. Oklab does, so the token pass converts
 * each hex to Oklab and merges below a fixed distance. The conversion is textbook and has
 * nothing to do with the schema, so it sits apart from the pass that uses it.
 */

/** A color in Oklab: lightness plus the two opponent axes. */
export interface Oklab {
	L: number;
	a: number;
	b: number;
}

/** Parse a #rrggbb hex string to rgb. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
	const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
	if (!m) return null;
	return { r: parseInt(m[1]!, 16), g: parseInt(m[2]!, 16), b: parseInt(m[3]!, 16) };
}

/** sRGB channel [0-255] to linear-light [0-1]. */
function srgbToLinear(c: number): number {
	const s = c / 255;
	return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** RGB to Oklab, the perceptually uniform model color clustering measures distance in. */
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
