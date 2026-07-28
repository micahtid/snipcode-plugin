/**
 * inspect/schema/tokens.ts: the design tokens and what they say about the system
 *
 * Pipeline position: inspect, page-scoped. See inspect/schema/extract.ts for the whole pass.
 * Reads from DOM: window, for computed styles on the already walked elements.
 * Writes to: nothing. Each function returns its token set.
 *
 * Why this exists: a page's design system is mostly its repeated values, so the schema
 * collects the colors, fonts, spacing, radii, and shadows the walk saw. Collection alone is
 * noisy, since a page paints hundreds of near-identical colors, so the palette is clustered
 * perceptually, the spacing is fitted to a base unit, and the type sizes are fitted to a
 * modular scale. The consistency score at the bottom reads those fits back out as the
 * fragmentation the redesign prompt should know about.
 *
 * Every collector here reads a computed style, and a computed style serializes whatever the
 * cascade produced, which is not always one value of the kind being asked for. Nothing in this
 * file decides that for itself: each candidate crosses validateToken in shared.ts, so a corner
 * shorthand, a pill radius, or a two-axis gap is handled once rather than at each call site
 * that happens to meet it first.
 */
import { hexToRgb, oklabDistance, rgbToOklab, type Oklab } from './oklab';
import {
	byLength, compositeOver, effectiveBackground, gradientStops, isTranslucent,
	parseRgba, validateToken, type ColorGroup, type WalkedElement,
} from './shared';
import type { ColorEntry, FontEntry } from './types';

// row-gap and column-gap, never the `gap` shorthand: with two different gaps the shorthand
// serializes as "40px 64px", which is not a length. The token gate would reject that anyway,
// but reading the two axes separately keeps both real values instead of losing the pair.
const SPACING_PROPS =['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'row-gap', 'column-gap'];
/** The four border sides, read one at a time. The shorthand is never read: it is not a color. */
const BORDER_SIDES = ['top', 'right', 'bottom', 'left'] as const;
/** A context below this share of a color's uses is noise, not a role, and is not reported. */
const TRIVIAL_CONTEXT_SHARE = 0.1;
/** How many of each token kind collection carries out, before the optimizer's own caps. */
const MAX_COLORS = 30;
const MAX_SPACING = 20;
const MAX_RADII = 10;
const MAX_SHADOWS = 8;

/** Known modular type-scale ratios, fitted against the page's font sizes. */
const MODULAR_SCALES: Array<{ name: string; ratio: number }> = [
	{ name: 'Minor Second', ratio: 1.067 },
	{ name: 'Major Second', ratio: 1.125 },
	{ name: 'Minor Third', ratio: 1.2 },
	{ name: 'Major Third', ratio: 1.25 },
	{ name: 'Perfect Fourth', ratio: 1.333 },
	{ name: 'Augmented Fourth', ratio: 1.414 },
	{ name: 'Perfect Fifth', ratio: 1.5 },
	{ name: 'Golden Ratio', ratio: 1.618 },
];

/** The spacing grid a page's values sit on, and the values that do not. */
interface SpacingAnalysis {
	baseUnit: number;
	gridCompliance: number;
	offGrid: string[];
}

/** One collected color before clustering: its uses, split by the part of the element it paints. */
interface RawColor {
	value: string;
	count: number;
	groups: Map<ColorGroup, number>;
	/** True when the color carries alpha, so it paints over whatever is behind it. */
	alpha: boolean;
	/** The hex this color resolves to on screen, which is where it sits for clustering. */
	clusterHex: string;
}

/**
 * Collects the page's colors, weighted by what each one paints.
 *
 * Three things make the result honest. A border color counts only when the side it belongs to
 * actually paints, so a framework reset that sets `border-color` on every element with zero
 * width no longer turns the page's text ink into a border token. Identical sides count once
 * per element rather than four times. And a gradient's stops are read out of background-image,
 * which is the only place a brand accent lives on a page that paints it as a gradient.
 */
export function collectColors(walked: WalkedElement[]): ColorEntry[] {
	const colorMap = new Map<string, RawColor>();
	const add = (raw: string, group: ColorGroup, el: Element): void => {
		const value = validateToken('color', raw)[0];
		if (!value) return;
		let record = colorMap.get(value);
		if (!record) {
			const alpha = isTranslucent(value);
			record = { value, count: 0, groups: new Map(), alpha, clusterHex: paintedHex(value, alpha, el) };
			colorMap.set(value, record);
		}
		record.count++;
		record.groups.set(group, (record.groups.get(group) ?? 0) + 1);
	};

	for (const el of walked) {
		const computed = window.getComputedStyle(el.element);
		add(computed.color, 'text', el.element);
		add(computed.backgroundColor, 'background', el.element);
		for (const side of paintingBorderColors(computed)) add(side, 'border', el.element);
		for (const stop of gradientStops(computed.backgroundImage)) add(stop, 'background', el.element);
		for (const pseudo of el.pseudoColors ?? []) add(pseudo.value, pseudo.group, el.element);
	}

	const raw = Array.from(colorMap.values()).sort((a, b) => b.count - a.count);
	return clusterColorsOklab(raw).slice(0, MAX_COLORS);
}

/** Where a color lands on screen: itself when opaque, composited over its backdrop when not. */
function paintedHex(value: string, alpha: boolean, el: Element): string {
	if (!alpha) return value;
	const rgba = parseRgba(value);
	if (!rgba) return value;
	return compositeOver(rgba, effectiveBackground(el));
}

/**
 * The distinct colors of the border sides that actually paint. A side with zero width or no
 * style still reports a color, and counting those is what made a page's ink read as a border.
 */
function paintingBorderColors(computed: CSSStyleDeclaration): string[] {
	const out = new Set<string>();
	for (const side of BORDER_SIDES) {
		const style = computed.getPropertyValue(`border-${side}-style`);
		if (!style || style === 'none' || style === 'hidden') continue;
		if (!(parseFloat(computed.getPropertyValue(`border-${side}-width`)) > 0)) continue;
		const color = computed.getPropertyValue(`border-${side}-color`).trim();
		if (color) out.add(color);
	}
	return Array.from(out);
}

/**
 * Clusters colors by Oklab perceptual distance, merging below 0.04, keeping the most frequent
 * member as the representative and a frequency-weighted centroid.
 *
 * Translucent colors cluster only against other translucent colors, positioned by the hex they
 * composite to. That gives a hairline like rgba(45,45,45,0.08) a real place in color space
 * instead of the zeroed position every alpha value used to share, while stopping the near-white
 * it paints from folding it into the page background and erasing it.
 */
function clusterColorsOklab(colors: RawColor[]): ColorEntry[] {
	interface ColorCluster {
		representative: RawColor;
		lab: Oklab;
		totalCount: number;
		groups: Map<ColorGroup, number>;
		members: RawColor[];
		alpha: boolean;
	}
	const clusters: ColorCluster[] = [];
	const threshold = 0.04;

	for (const color of colors) {
		const rgb = hexToRgb(color.clusterHex);
		if (!rgb) {
			clusters.push({ representative: color, lab: { L: 0, a: 0, b: 0 }, totalCount: color.count, groups: new Map(color.groups), members: [color], alpha: color.alpha });
			continue;
		}

		const lab = rgbToOklab(rgb.r, rgb.g, rgb.b);
		let merged = false;
		for (const cluster of clusters) {
			if (cluster.alpha !== color.alpha) continue;
			if (oklabDistance(lab, cluster.lab) >= threshold) continue;
			cluster.members.push(color);
			cluster.totalCount += color.count;
			for (const [group, count] of color.groups) cluster.groups.set(group, (cluster.groups.get(group) ?? 0) + count);
			if (color.count > cluster.representative.count) cluster.representative = color;

			const totalWeight = cluster.members.reduce((s, m) => s + m.count, 0);
			let wL = 0, wA = 0, wB = 0;
			for (const m of cluster.members) {
				const mRgb = hexToRgb(m.clusterHex);
				if (!mRgb) continue;
				const mLab = rgbToOklab(mRgb.r, mRgb.g, mRgb.b);
				wL += mLab.L * m.count;
				wA += mLab.a * m.count;
				wB += mLab.b * m.count;
			}
			cluster.lab = { L: wL / totalWeight, a: wA / totalWeight, b: wB / totalWeight };
			merged = true;
			break;
		}
		if (!merged) clusters.push({ representative: color, lab, totalCount: color.count, groups: new Map(color.groups), members: [color], alpha: color.alpha });
	}

	return clusters
		.map((c) => ({
			value: c.representative.value,
			contexts: weightedContexts(c.groups),
			count: c.totalCount,
			usage: Object.fromEntries(c.groups),
		}))
		.sort((a, b) => b.count - a.count);
}

/**
 * Ranks a color's contexts by how much of its use each accounts for, dropping the trivial
 * ones. A color used four hundred times as text and twice as a border is a text color; a flat
 * list that gave both equal standing is what made a redesign outline every card in body ink.
 */
export function weightedContexts(groups: Map<ColorGroup, number> | Record<string, number>): string[] {
	const entries = groups instanceof Map ? Array.from(groups.entries()) : Object.entries(groups);
	const total = entries.reduce((sum, [, count]) => sum + count, 0);
	if (total <= 0) return [];
	const ranked = entries.slice().sort((a, b) => b[1] - a[1]);
	const kept = ranked.filter(([, count], i) => i === 0 || count / total >= TRIVIAL_CONTEXT_SHARE);
	return kept.map(([group]) => group);
}

/** Collects the font families used, with their sizes, weights, and inferred usage. */
export function collectFonts(walked: WalkedElement[]): FontEntry[] {
	const fontMap = new Map<string, { sizes: Set<string>; weights: Set<number>; roles: Set<string> }>();
	for (const el of walked) {
		const computed = window.getComputedStyle(el.element);
		const family = computed.fontFamily.split(',')[0]!.trim().replace(/["']/g, '');
		const sizes = validateToken('font-size', computed.fontSize);
		const weight = parseInt(computed.fontWeight) || 400;
		const existing = fontMap.get(family);
		if (existing) {
			for (const size of sizes) existing.sizes.add(size);
			existing.weights.add(weight);
			existing.roles.add(el.role);
		} else {
			fontMap.set(family, { sizes: new Set(sizes), weights: new Set([weight]), roles: new Set([el.role]) });
		}
	}
	return Array.from(fontMap.entries()).map(([family, data]) => ({
		family,
		sizes: Array.from(data.sizes).sort(byLength),
		weights: Array.from(data.weights).sort((a, b) => a - b),
		usage: inferFontUsage(data.roles),
	}));
}

/** Infers a font's role, heading / body / ui / mixed, from the roles it appears in. */
function inferFontUsage(roles: Set<string>): string {
	if (roles.has('heading')) return 'heading';
	if (roles.has('paragraph') || roles.has('text')) return 'body';
	if (roles.has('button') || roles.has('input')) return 'ui';
	return 'mixed';
}

/** Collects the distinct non-zero spacing values, sorted ascending, top 20. */
export function collectSpacing(walked: WalkedElement[]): string[] {
	const spacingSet = new Set<string>();
	for (const el of walked) {
		const computed = window.getComputedStyle(el.element);
		for (const prop of SPACING_PROPS) {
			for (const value of validateToken('spacing', computed.getPropertyValue(prop))) spacingSet.add(value);
		}
	}
	return Array.from(spacingSet).sort(byLength).slice(0, MAX_SPACING);
}

/**
 * Collects the distinct corner radii, sorted ascending.
 *
 * Everything the gate does shows up here: a corner shorthand enters as its distinct corner
 * values rather than as the one string "32px 32px 0px 0px", and a pill, which a browser
 * serializes as a radius of 3.35544e+07px, enters as the 9999px a page would author for the
 * same shape.
 */
export function collectRadii(walked: WalkedElement[]): string[] {
	const values = new Set<string>();
	for (const el of walked) {
		for (const radius of validateToken('radius', el.properties['br'] ?? '')) values.add(radius);
	}
	return Array.from(values).sort(byLength).slice(0, MAX_RADII);
}

/** Collects the distinct box-shadow values that actually paint. */
export function collectShadows(walked: WalkedElement[]): string[] {
	const shadows = new Set<string>();
	for (const el of walked) {
		for (const shadow of validateToken('shadow', el.properties['bs'] ?? '')) shadows.add(shadow);
	}
	return Array.from(shadows).slice(0, MAX_SHADOWS);
}

/** Detects the spacing base unit (4/5/6/8/10) and how much spacing sits on that grid. */
export function analyzeSpacingBaseUnit(spacing: string[]): SpacingAnalysis | null {
	const pxValues = spacing.map((v) => parseFloat(v)).filter((v) => !isNaN(v) && v > 0);
	if (pxValues.length < 3) return null;

	let bestBase = 4;
	let bestScore = 0;
	for (const base of [4, 5, 6, 8, 10]) {
		const onGrid = pxValues.filter((v) => Math.abs(v % base) < 0.5).length;
		const score = onGrid / pxValues.length;
		if (score > bestScore) {
			bestScore = score;
			bestBase = base;
		}
	}

	const offGrid = spacing.filter((v) => {
		const px = parseFloat(v);
		return !isNaN(px) && px > 0 && Math.abs(px % bestBase) >= 0.5;
	});

	return { baseUnit: bestBase, gridCompliance: Math.round(bestScore * 100) / 100, offGrid: offGrid.slice(0, 10) };
}

/** Fits the page's font sizes to the closest modular type scale, or null if no good fit. */
export function detectTypographyScale(fonts: FontEntry[]): { ratio: number; name: string; base: number; deviation: number } | null {
	const allSizes = new Set<number>();
	for (const font of fonts) {
		for (const size of font.sizes) {
			const px = parseFloat(size);
			if (!isNaN(px) && px > 0) allSizes.add(px);
		}
	}

	const sizes = Array.from(allSizes).sort((a, b) => a - b);
	if (sizes.length < 3) return null;

	const bodySizes = sizes.filter((s) => s >= 12 && s <= 18);
	const base = bodySizes.length > 0 ? bodySizes[0]! : sizes[0]!;

	let bestRatio = 1.2;
	let bestName = 'Minor Third';
	let bestDeviation = Infinity;
	for (const { name, ratio } of MODULAR_SCALES) {
		const logRatio = Math.log(ratio);
		let totalDeviation = 0;
		let count = 0;
		for (const size of sizes) {
			if (size === base) continue;
			const logScale = Math.log(size / base) / logRatio;
			const nearestInt = Math.round(logScale);
			if (nearestInt === 0) continue;
			totalDeviation += Math.abs(logScale - nearestInt);
			count++;
		}
		const avgDeviation = count > 0 ? totalDeviation / count : Infinity;
		if (avgDeviation < bestDeviation) {
			bestDeviation = avgDeviation;
			bestRatio = ratio;
			bestName = name;
		}
	}

	if (bestDeviation > 0.3) return null;
	return { ratio: bestRatio, name: bestName, base, deviation: Math.round(bestDeviation * 1000) / 1000 };
}

/** Scores design consistency across the token sets and flags fragmentation issues. */
export function analyzeConsistency(
	colors: ColorEntry[],
	radii: string[],
	shadows: string[],
	spacingAnalysis: SpacingAnalysis | null,
): { colors: number; spacing: number; radii: number; shadows: number; issues: string[] } {
	const issues: string[] = [];

	const colorScore = colors.length;
	if (colorScore > 15) issues.push(`High color count (${colorScore}) suggests inconsistent palette`);

	const spacingScore = spacingAnalysis ? spacingAnalysis.gridCompliance : 0;
	if (spacingScore < 0.6) issues.push(`Low grid compliance (${Math.round(spacingScore * 100)}%) - spacing is ad-hoc`);

	const radiiScore = radii.length;
	if (radiiScore > 5) issues.push(`Fragmented border-radii (${radiiScore} unique values)`);
	if (radiiScore >= 10) issues.push('CRITICAL: border-radius is highly inconsistent');

	const shadowScore = shadows.length;
	if (shadowScore > 5) issues.push(`Many shadow variants (${shadowScore}) - consider a shadow scale`);

	return { colors: colorScore, spacing: Math.round(spacingScore * 100), radii: radiiScore, shadows: shadowScore, issues };
}
