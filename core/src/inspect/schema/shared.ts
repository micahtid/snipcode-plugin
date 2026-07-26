/**
 * inspect/schema/shared.ts: the walked-element record and the helpers every schema pass uses
 *
 * Pipeline position: inspect, page-scoped. See inspect/schema/extract.ts for the whole pass.
 * Reads from DOM: window, for the computed styles the callers hand in.
 * Writes to: nothing.
 *
 * Why this exists: the schema extractor is split across a walk, a token pass, a structure
 * pass, a section pass, and a blueprint pass. A handful of small definitions are needed by
 * more than one of them, chiefly the record the walk produces and the paint and grouping
 * helpers. They live here so no pass imports another just to borrow a helper, which is what
 * would put a cycle in the graph.
 *
 * validateToken at the bottom is the one boundary every candidate token crosses. It lives here
 * for the same reason: every collector needs it, and a gate that only some of them go through
 * is not a gate.
 */
import { splitCommaList } from '../../utils/css-split';
import type { SemanticRole } from './classify';
import { classNameOf } from './classify';

/** Which part of an element a color paints. The palette reports these, weighted, not raw props. */
export type ColorGroup = 'text' | 'background' | 'border';

/** One color a pseudo-element paints, with the part of the element it paints. */
export interface PseudoColor {
	value: string;
	group: ColorGroup;
}

/** One element captured by the walk, with its role, fingerprint, and tree position. */
export interface WalkedElement {
	element: Element;
	tag: string;
	role: SemanticRole;
	fingerprint: string;
	properties: Record<string, string>;
	parent: Element | null;
	depth: number;
	pseudoColors?: PseudoColor[];
	repeat?: number; // Collapsed identical-sibling count, filled during dedup.
}

/** A button element or a link styled as a button. This is shared across the button-detection passes. */
export const BUTTON_SELECTOR = 'button, a[class*="btn"], a[class*="button"]';

/** How many ancestors the backdrop search climbs before it falls back to white. */
const MAX_BACKDROP_CLIMB = 24;

/** One color parsed out of a css value: channels plus alpha. */
export interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

/** Whether a normalized color value is fully transparent, painting nothing. */
export function isTransparentColor(value: string): boolean {
	return value === 'transparent' || value === 'rgba(0, 0, 0, 0)';
}

/** Counts the color tokens in a css value, so a multi-value shorthand can be rejected. */
function countColorTokens(value: string): number {
	return (value.match(/rgba?\(|hsla?\(|#[0-9a-f]{3,8}\b/gi) ?? []).length;
}

/**
 * Normalizes a paint value to hex when opaque, keeps rgba when translucent, null if absent.
 *
 * A value carrying more than one color is rejected outright. `border-color` on an element
 * with different colors per side serializes as "rgb(a) rgb(b) rgb(c)", which is not a color;
 * accepting it put strings like that into the palette as if they were tokens.
 */
export function normalizeColor(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed || isTransparentColor(trimmed)) return null;
	if (countColorTokens(trimmed) > 1) return null;
	if (countColorTokens(trimmed) === 0 && /\s/.test(trimmed)) return null;

	const rgba = parseRgba(trimmed);
	if (rgba) {
		if (rgba.a <= 0) return null;
		if (rgba.a < 1) return trimmed;
		return rgbToHex(rgba);
	}
	return trimmed;
}

/** Parses rgb()/rgba() in either comma or slash notation, null when the value is not one. */
export function parseRgba(value: string): Rgba | null {
	const m = value.trim().match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i);
	if (!m) return null;
	const alphaRaw = m[4] === undefined ? 1 : parseFloat(m[4]);
	const alpha = m[5] === '%' ? alphaRaw / 100 : alphaRaw;
	return { r: parseFloat(m[1]!), g: parseFloat(m[2]!), b: parseFloat(m[3]!), a: isNaN(alpha) ? 1 : alpha };
}

/** Serializes rgb channels as #rrggbb, dropping any alpha. */
export function rgbToHex(rgb: { r: number; g: number; b: number }): string {
	return '#' + [rgb.r, rgb.g, rgb.b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('');
}

/** True when a normalized color still carries alpha, meaning it paints over what is behind it. */
export function isTranslucent(value: string): boolean {
	const rgba = parseRgba(value);
	return rgba !== null && rgba.a < 1;
}

/** Alpha-composites a translucent color over an opaque backdrop, returning the painted hex. */
export function compositeOver(fg: Rgba, backdropHex: string): string {
	const back = parseRgba(backdropHex) ?? hexChannels(backdropHex) ?? { r: 255, g: 255, b: 255, a: 1 };
	return rgbToHex({
		r: fg.r * fg.a + back.r * (1 - fg.a),
		g: fg.g * fg.a + back.g * (1 - fg.a),
		b: fg.b * fg.a + back.b * (1 - fg.a),
	});
}

/** Channels of a #rrggbb string, null when it is not one. */
function hexChannels(hex: string): Rgba | null {
	const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
	if (!m) return null;
	return { r: parseInt(m[1]!, 16), g: parseInt(m[2]!, 16), b: parseInt(m[3]!, 16), a: 1 };
}

/**
 * The opaque color an element actually sits on, found by climbing to the first ancestor that
 * paints a background and compositing any translucency on the way down. This is what a
 * translucent token has to be measured against; without it a hairline border has no position
 * in color space at all.
 */
export function effectiveBackground(el: Element | null): string {
	let current: Element | null = el;
	for (let i = 0; i < MAX_BACKDROP_CLIMB && current; i++) {
		const rgba = parseRgba(window.getComputedStyle(current).backgroundColor);
		if (rgba && rgba.a > 0) {
			if (rgba.a >= 1) return rgbToHex(rgba);
			return compositeOver(rgba, effectiveBackground(current.parentElement));
		}
		current = current.parentElement;
	}
	return '#ffffff';
}

/**
 * A box-shadow with its fully transparent layers dropped, 'none' when nothing is left.
 *
 * Utility frameworks stack placeholder layers so a shadow can be switched on by a variant, so
 * an element with no shadow at all still computes to a list of `rgba(0,0,0,0)` layers. Reported
 * verbatim that reads as an elevated component with a five-layer shadow, which is a design fact
 * the page does not contain.
 */
export function paintedShadow(value: string): string {
	if (!value || value === 'none') return 'none';
	const painted = splitCommaList(value).filter((layer) => {
		const color = layer.match(/rgba?\([^)]*\)/i);
		const rgba = color ? parseRgba(color[0]) : null;
		return !rgba || rgba.a > 0;
	});
	return painted.length > 0 ? painted.join(', ') : 'none';
}

/** The color stops of a gradient background-image, in order. Empty for any other value. */
export function gradientStops(backgroundImage: string): string[] {
	if (!backgroundImage || !backgroundImage.includes('gradient(')) return [];
	const stops: string[] = [];
	for (const token of backgroundImage.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}\b/gi) ?? []) {
		const normalized = normalizeColor(token);
		if (normalized) stops.push(normalized);
	}
	return stops;
}

/** The four-side padding shorthand read off a computed style. */
export function paddingShorthand(computed: CSSStyleDeclaration): string {
	return `${computed.paddingTop} ${computed.paddingRight} ${computed.paddingBottom} ${computed.paddingLeft}`;
}

/** The token kinds the gate knows, each with its own idea of what one sane value looks like. */
export type TokenKind = 'color' | 'radius' | 'spacing' | 'font-size' | 'shadow';

/** A radius past this share of the viewport's shorter side is a pill, not a measured corner. */
const PILL_RADIUS_SHARE = 0.5;
/** What a pill normalizes to: the value a page would author for the same shape. */
const PILL_RADIUS = '9999px';
/** Longest length, in px, that is a design value rather than a serialization artifact. */
const MAX_LENGTH_PX = 5000;
/** Font sizes outside this band are not type: below it nothing renders, above it is an artifact. */
const MIN_FONT_PX = 4;
const MAX_FONT_PX = 400;

/**
 * The one gate every candidate token crosses: the values of `kind` a string actually carries.
 *
 * None when the string is not a value of that kind at all, one for the ordinary case, and
 * several when it is a shorthand listing distinct values of the same kind. Everything upstream
 * of this reads a computed style, and a computed style serializes whatever the cascade produced:
 * a corner shorthand where a radius was expected, a pill authored as 3.35544e+07px, a gap
 * shorthand where a length belonged. Each of those used to be patched at the call site that
 * first met it, so the next serialization surprise got through somewhere else. One gate is what
 * makes that class of defect finite.
 */
export function validateToken(kind: TokenKind, value: string): string[] {
	const trimmed = (value ?? '').trim();
	if (!trimmed || trimmed === 'none' || trimmed === 'normal' || trimmed === 'auto') return [];

	if (kind === 'color') {
		const color = normalizeColor(trimmed);
		return color ? [color] : [];
	}
	if (kind === 'shadow') {
		const painted = paintedShadow(trimmed);
		return painted === 'none' ? [] : [painted];
	}
	if (kind === 'radius') {
		// A corner shorthand lists up to four radii, and the elliptical form separates its two
		// axes with a slash. Both are lists of radii, so each distinct member enters on its own
		// rather than the whole string entering as if it were one value.
		const out: string[] = [];
		for (const part of trimmed.replace('/', ' ').split(/\s+/)) {
			const radius = normalizeRadius(part);
			if (radius && !out.includes(radius)) out.push(radius);
		}
		return out;
	}

	// Spacing and font sizes are single lengths, so a multi-value string is a shorthand read
	// where a value belonged, and it is not a length whatever else it may mean.
	if (/\s/.test(trimmed)) return [];
	const px = lengthPx(trimmed);
	if (px === null) return [];
	if (kind === 'spacing') return px > 0 && px <= MAX_LENGTH_PX ? [trimmed] : [];
	return px >= MIN_FONT_PX && px <= MAX_FONT_PX ? [trimmed] : [];
}

/**
 * A border-radius as a component blueprint states it: every corner through the same gate the
 * token list uses, with the positions kept.
 *
 * A blueprint is a shape, not a token, so `12px 0px 0px 12px` is a real answer about a card and
 * has to survive whole, zeros included. What must not survive is a pill serialized as
 * 3.35544e+07px, which reached schema.md down this path while the token list beside it, reading
 * the same element, printed a clean 9999px.
 */
export function radiusShorthand(value: string): string {
	const trimmed = (value ?? '').trim();
	if (!trimmed || trimmed === 'none') return '0px';
	return trimmed
		.split('/')
		.map((axis) => axis.trim().split(/\s+/).map(cornerRadius).join(' '))
		.join(' / ');
}

/** One corner, with a pill collapsed to the shape a page would author for it. */
function cornerRadius(part: string): string {
	if (part.endsWith('%')) return part;
	const px = lengthPx(part);
	if (px === null) return part;
	if (px <= 0) return '0px';
	return px >= Math.min(window.innerWidth, window.innerHeight) * PILL_RADIUS_SHARE ? PILL_RADIUS : part;
}

/** One radius for the token list: a corner, with zero and anything unparseable dropped. */
function normalizeRadius(part: string): string | null {
	const corner = cornerRadius(part);
	if (corner === '0px') return null;
	if (corner.endsWith('%')) return parseFloat(corner) > 0 ? corner : null;
	return lengthPx(corner) === null ? null : corner;
}

/** A css length in px, null when the string is not a length. Exponent notation included: that is
 * how a browser serializes the enormous radius a pill is authored with. */
function lengthPx(value: string): number | null {
	if (!/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:px|rem|em|pt)?$/i.test(value)) return null;
	const n = parseFloat(value);
	if (isNaN(n)) return null;
	return /r?em$/i.test(value) ? n * 16 : n;
}

/** Sorts token strings by the length they represent, so a scale reads small to large. */
export function byLength(a: string, b: string): number {
	return (parseFloat(a) || 0) - (parseFloat(b) || 0);
}

/** Groups items by a string key, preserving insertion order within each group. */
export function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const key = keyOf(item);
		const group = groups.get(key) || [];
		group.push(item);
		groups.set(key, group);
	}
	return groups;
}

/** True when an anchor is styled like a button, with btn/button/cta in its class list. */
export function isButtonLike(el: Element): boolean {
	return /btn|button|cta/.test(classNameOf(el));
}
