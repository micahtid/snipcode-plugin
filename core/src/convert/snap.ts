/**
 * convert/snap.ts: normalizing values before tailwind matching.
 *
 * Baked values are exact computed pixels. Before matching they read better and map to
 * utilities more cleanly as rem lengths and hex colors, which are tailwind's own forms.
 *
 * It deliberately does not snap to a design grid or a type scale: rounding 13px to 12px is
 * visible drift, so only the unit or format changes. Which properties keep px is decided by a
 * category predicate rather than a property-name list.
 */
import { parseRgba, rgbToHex } from '../utils/color';

const PX_LEN = /(-?\d*\.?\d+(?:e[+-]?\d+)?)px\b/gi;
const RGB_FN = /rgba?\(([^)]+)\)/gi;
const ROOT_FONT_SIZE = 16; // Px, the tailwind/browser default root.

/** The result of a snap: the possibly transformed value and whether it changed. */
export interface SnapResult {
	value: string;
	snapped: boolean;
}

/**
 * Normalizes one declaration's value: opaque rgb() to hex, and px lengths to rem unless the
 * property is px-native. Multi-token values snap each length on its own. A custom property, or
 * any value carrying a css function, passes through untouched. See the body for why.
 *
 * @param property - the css property, which decides px-vs-rem treatment
 */
export function snapValue(property: string, value: string): SnapResult {
	let result = value;

	// A custom property is an opaque substitution token dropped verbatim into consumers whose
	// context is unknown here. Snapping `0px` to unitless `0` makes a consumer's
	// `max(22px, var(--x))` mix a length with a number, which drops the whole declaration.
	if (property.startsWith('--')) {
		return { value, snapped: false };
	}

	// A value carrying a css function is left alone. The regexes below match one level of
	// parentheses, so `rgb(R G B / var(--opacity))` truncates at the inner `)` into a value
	// the parser drops. The computed value renders the same either way, so skipping costs
	// readability and never a pixel.
	if (/\bvar\(|\bcalc\(|\bclamp\(|\bmin\(|\bmax\(/.test(value)) {
		return { value, snapped: false };
	}

	// Colors: opaque rgb()/rgba() -> hex, regardless of property.
	result = result.replace(RGB_FN, (match: string) => opaqueRgbToHex(match));

	// A px-native property keeps its exact px, deliberately not rounded to an integer.
	// letter-spacing -0.374px to 0px loses the tracking, and a shadow blur 1.899px to 2px
	// moves the shadow. Every other length divides by the artifact's 16px root, so the rem
	// reproduces the same px.
	if (!pixelNative(property)) {
		result = result.replace(PX_LEN, (_m, n: string) => pxToRem(parseFloat(n)));
	}

	return { value: result, snapped: result !== value };
}

/**
 * True for properties whose lengths read best in px: border and outline widths and offsets,
 * shadows, and border-spacing. Radius is excluded, since it reads better in rem. A category
 * predicate, because a border width is a px-native mechanism rather than a curated list.
 */
function pixelNative(property: string): boolean {
	if (/radius/.test(property)) return false;
	return (
		/(?:^|-)(?:border|outline)(?:$|-)/.test(property) ||
		/shadow/.test(property) ||
		/spacing/.test(property) ||
		/outline-offset/.test(property)
	);
}

/** Px -> rem string (÷16), trimmed of trailing zeros. "0" stays unitless. */
function pxToRem(px: number): string {
	if (px === 0) return '0';
	const rem = px / ROOT_FONT_SIZE;
	// Six decimals, not four, so the round-trip stays inside getComputedStyle's own
	// quantization. At four it drifts about 0.0008px, which a computed-style diff reads as a
	// divergence even though nothing moved.
	return `${parseFloat(rem.toFixed(6))}rem`;
}

/**
 * Convert an opaque rgb()/rgba() to #hex, leaving alpha and out-of-range channels alone. The
 * shared serializer clamps, and a value outside 0-255 is not one this pass should rewrite.
 */
function opaqueRgbToHex(original: string): string {
	const rgba = parseRgba(original);
	if (!rgba) return original;
	if (![rgba.r, rgba.g, rgba.b].every((n) => n >= 0 && n <= 255)) return original;
	if (rgba.a < 1) return original; // Keep alpha as rgba()
	return rgbToHex(rgba);
}
