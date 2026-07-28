/**
 * inspect/schema/optimize.ts: trimming the schema to what fits in one read.
 *
 * Post-processes the extracted schema: dedupe and cap the palette, sort and bound spacing, cap
 * the states, sections, and blueprints. Trimming is not free of meaning, because a cap can cut
 * the section an effect names, so anything pointing at a section is reconciled here rather
 * than left for the renderer to discover broken.
 */
import { weightedContexts } from './tokens';
import type { PageSchema } from './types';

/** Returns a size-reduced copy of the schema, ready to serialize and render. */
export function optimizeSchema(schema: PageSchema): PageSchema {
	const optimized: PageSchema = { ...schema };

	optimized.tokens = {
		...optimized.tokens,
		colors: deduplicateColors(schema.tokens.colors),
		spacing: optimizeSpacing(schema.tokens.spacing),
		radii: [...new Set(schema.tokens.radii)].slice(0, 8),
		shadows: [...new Set(schema.tokens.shadows)].slice(0, 6),
		...(schema.tokens.scaleAnalysis ? { scaleAnalysis: schema.tokens.scaleAnalysis } : {}),
	};

	if (optimized.states.length > 30) optimized.states = optimized.states.slice(0, 30);
	if (optimized.sections.length > 15) optimized.sections = optimized.sections.slice(0, 15);
	if (optimized.contentPatterns.length > 8) optimized.contentPatterns = optimized.contentPatterns.slice(0, 8);
	if (optimized.buttons.length > 4) optimized.buttons = optimized.buttons.slice(0, 4);
	if (optimized.cards.length > 3) optimized.cards = optimized.cards.slice(0, 3);
	optimized.decorative = dropUnplacedEffects(optimized.decorative, optimized.sections.length);

	return optimized;
}

/**
 * Drops background effects whose section index falls outside the trimmed sections list.
 *
 * The extractor indexes an effect against every discovered section, and the cap above can cut
 * the section it named. An index pointing past the list is not a location, and a located fact
 * that cannot be placed is worse than no fact at all.
 */
function dropUnplacedEffects(decorative: PageSchema['decorative'], sectionCount: number): PageSchema['decorative'] {
	const effects = decorative?.backgroundEffects ?? [];
	const placed = effects.filter((entry) => entry.section === undefined || entry.section < sectionCount);
	return placed.length === effects.length ? decorative : { ...decorative, backgroundEffects: placed };
}

/**
 * Merge colors that normalize to the same value, summing counts and per-context usage. Keep
 * the top 25. The context list is recomputed from the merged usage rather than unioned, so a
 * merge cannot reintroduce a context the weighting already ruled trivial.
 */
function deduplicateColors(colors: PageSchema['tokens']['colors']): PageSchema['tokens']['colors'] {
	const merged = new Map<string, { usage: Record<string, number>; contexts: string[]; count: number }>();
	for (const entry of colors) {
		const normalized = entry.value.toLowerCase();
		const existing = merged.get(normalized);
		if (existing) {
			existing.count += entry.count;
			for (const [group, count] of Object.entries(entry.usage ?? {})) {
				existing.usage[group] = (existing.usage[group] ?? 0) + count;
			}
			for (const context of entry.contexts) if (!existing.contexts.includes(context)) existing.contexts.push(context);
		} else {
			merged.set(normalized, { usage: { ...(entry.usage ?? {}) }, contexts: [...entry.contexts], count: entry.count });
		}
	}
	return Array.from(merged.entries())
		.map(([value, data]) => {
			const contexts = Object.keys(data.usage).length > 0 ? weightedContexts(data.usage) : data.contexts;
			return { value, contexts, count: data.count, ...(Object.keys(data.usage).length > 0 ? { usage: data.usage } : {}) };
		})
		.sort((a, b) => b.count - a.count)
		.slice(0, 25);
}

/** Sort and dedupe spacing values, drop outliers (>200px), keep the smallest 15. */
function optimizeSpacing(spacing: string[]): string[] {
	return [...new Set(spacing)]
		.map((v) => ({ raw: v, px: parseFloat(v) }))
		.filter((v) => !isNaN(v.px) && v.px > 0 && v.px <= 200)
		.sort((a, b) => a.px - b.px)
		.map((v) => v.raw)
		.slice(0, 15);
}

