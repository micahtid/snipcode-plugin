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
 */
import { hexToRgb, oklabDistance, rgbToOklab, type Oklab } from './oklab';
import { isTransparentColor, normalizeColor, type WalkedElement } from './shared';
import type { ColorEntry, FontEntry } from './types';

const COLOR_PROPS = ['color', 'background-color', 'border-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'];
const SPACING_PROPS = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'gap'];

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
export interface SpacingAnalysis {
	baseUnit: number;
	gridCompliance: number;
	offGrid: string[];
}

/** Collects the page's colors, from paint props and pseudo-element colors, Oklab-clustered. */
export function collectColors(walked: WalkedElement[]): ColorEntry[] {
	const colorMap = new Map<string, { contexts: Set<string>; count: number }>();
	const add = (value: string, context: string): void => {
		const existing = colorMap.get(value);
		if (existing) {
			existing.contexts.add(context);
			existing.count++;
		} else {
			colorMap.set(value, { contexts: new Set([context]), count: 1 });
		}
	};

	for (const el of walked) {
		const computed = window.getComputedStyle(el.element);
		for (const prop of COLOR_PROPS) {
			const value = computed.getPropertyValue(prop).trim();
			if (!value || isTransparentColor(value)) continue;
			const normalized = normalizeColor(value);
			if (normalized) add(normalized, prop);
		}
		for (const pc of el.pseudoColors ?? []) add(pc, 'pseudo');
	}

	const rawEntries = Array.from(colorMap.entries())
		.map(([value, data]) => ({ value, contexts: Array.from(data.contexts), count: data.count }))
		.sort((a, b) => b.count - a.count);

	return clusterColorsOklab(rawEntries).slice(0, 30);
}

/**
 * Clusters colors by Oklab perceptual distance, merging below 0.04, keeping the
 * most frequent member as the representative and a frequency-weighted centroid.
 * Non-hex colors, for example rgba with alpha, are kept as singleton clusters.
 */
function clusterColorsOklab(colors: ColorEntry[]): ColorEntry[] {
	if (colors.length <= 1) return colors;

	interface ColorCluster {
		representative: ColorEntry;
		lab: Oklab;
		totalCount: number;
		contexts: Set<string>;
		members: ColorEntry[];
	}
	const clusters: ColorCluster[] = [];
	const threshold = 0.04;

	for (const color of colors) {
		const rgb = hexToRgb(color.value);
		if (!rgb) {
			clusters.push({ representative: color, lab: { L: 0, a: 0, b: 0 }, totalCount: color.count, contexts: new Set(color.contexts), members: [color] });
			continue;
		}

		const lab = rgbToOklab(rgb.r, rgb.g, rgb.b);
		let merged = false;
		for (const cluster of clusters) {
			if (oklabDistance(lab, cluster.lab) >= threshold) continue;
			cluster.members.push(color);
			cluster.totalCount += color.count;
			color.contexts.forEach((c) => cluster.contexts.add(c));
			if (color.count > cluster.representative.count) cluster.representative = color;

			const totalWeight = cluster.members.reduce((s, m) => s + m.count, 0);
			let wL = 0, wA = 0, wB = 0;
			for (const m of cluster.members) {
				const mRgb = hexToRgb(m.value);
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
		if (!merged) clusters.push({ representative: color, lab, totalCount: color.count, contexts: new Set(color.contexts), members: [color] });
	}

	return clusters
		.map((c) => ({ value: c.representative.value, contexts: Array.from(c.contexts), count: c.totalCount }))
		.sort((a, b) => b.count - a.count);
}

/** Collects the font families used, with their sizes, weights, and inferred usage. */
export function collectFonts(walked: WalkedElement[]): FontEntry[] {
	const fontMap = new Map<string, { sizes: Set<string>; weights: Set<number>; roles: Set<string> }>();
	for (const el of walked) {
		const computed = window.getComputedStyle(el.element);
		const family = computed.fontFamily.split(',')[0]!.trim().replace(/["']/g, '');
		const existing = fontMap.get(family);
		if (existing) {
			existing.sizes.add(computed.fontSize);
			existing.weights.add(parseInt(computed.fontWeight) || 400);
			existing.roles.add(el.role);
		} else {
			fontMap.set(family, { sizes: new Set([computed.fontSize]), weights: new Set([parseInt(computed.fontWeight) || 400]), roles: new Set([el.role]) });
		}
	}
	return Array.from(fontMap.entries()).map(([family, data]) => ({
		family,
		sizes: Array.from(data.sizes).sort((a, b) => parseFloat(a) - parseFloat(b)),
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
			const value = computed.getPropertyValue(prop).trim();
			if (value && value !== '0px' && value !== 'normal' && value !== 'auto') spacingSet.add(value);
		}
	}
	return Array.from(spacingSet).sort((a, b) => parseFloat(a) - parseFloat(b)).slice(0, 20);
}

/** Collects distinct non-default values of one abbreviated fingerprint property. */
export function collectValues(walked: WalkedElement[], propAbbr: string): string[] {
	const values = new Set<string>();
	for (const el of walked) {
		const val = el.properties[propAbbr];
		if (val && val !== '0px' && val !== 'none') values.add(val);
	}
	return Array.from(values).slice(0, 10);
}

/** Collects the distinct box-shadow values seen. */
export function collectShadows(walked: WalkedElement[]): string[] {
	const shadows = new Set<string>();
	for (const el of walked) {
		const val = el.properties['bs'];
		if (val && val !== 'none') shadows.add(val);
	}
	return Array.from(shadows).slice(0, 8);
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
