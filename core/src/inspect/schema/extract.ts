/**
 * inspect/schema/extract.ts: the page-schema extractor
 *
 * Pipeline position: inspect, page-scoped. It reads the live dom directly and does not run the element pipeline.
 * Reads from DOM: document/window. This runs live, so the whole page must be loaded.
 * Writes to: nothing. This is pure extraction, and it returns a PageSchema.
 *
 * Principles applied: none. This is extraction.
 *
 * Why this exists: the schema inspector turns a whole page into a compressed
 * design-system schema. It walks the visible dom, stratified by section so a long
 * page samples evenly, collects the color / font / spacing / radius / shadow
 * tokens, dedupes elements into a style map and a structure tree, lifts
 * interactive-state rules from the readable stylesheets, and detects section
 * blueprints and the button, card, and nav component blueprints plus the page's
 * decorative and responsive language. The result is optimized (inspect/schema/optimize.ts) and,
 * with a key, synthesized by the ai pass (inspect/ai.ts). Ported by rewriting from
 * v1 schema/schema-extractor.ts as plain functions, dropping the class/logger
 * ceremony and v1's discarded root-variable pass. Cross-origin stylesheets are read
 * only when same-origin-readable, matching the other page-scoped inspectors.
 *
 * This file is the order of operations and nothing else. Each pass lives in its own
 * module: the sample in walk.ts, the design tokens in tokens.ts, the style map and
 * structure tree in structure.ts, the section reading in sections.ts, and the component
 * and page-language specs in blueprints.ts. Anything two passes both need is in shared.ts.
 */
import { detectPatterns, walkDOM } from './walk';
import {
	analyzeConsistency, analyzeSpacingBaseUnit, collectColors, collectFonts,
	collectShadows, collectSpacing, collectValues, detectTypographyScale,
} from './tokens';
import { assemble, extractStates } from './structure';
import { extractContentPatterns, extractSections } from './sections';
import {
	extractButtonBlueprints, extractCardBlueprints, extractDecorativeInfo,
	extractNavBlueprint, extractResponsiveInfo,
} from './blueprints';
import type { PageSchema } from './types';

/** Builds the complete page schema from the live dom. */
export function extractPageSchema(): PageSchema {
	const walked = walkDOM();
	const rules = readableRules();

	const colors = collectColors(walked);
	const fonts = collectFonts(walked);
	const spacing = collectSpacing(walked);
	const radii = collectValues(walked, 'br');
	const shadows = collectShadows(walked);

	const spacingAnalysis = analyzeSpacingBaseUnit(spacing);
	const scaleAnalysis = detectTypographyScale(fonts);

	const { deduplicated, components } = detectPatterns(walked);
	const states = extractStates(rules, walked);
	const { styles, structure } = assemble(deduplicated);

	const sections = extractSections();
	const contentPatterns = extractContentPatterns(sections);

	const buttons = extractButtonBlueprints(walked, states);
	const cards = extractCardBlueprints(walked, states);
	const nav = extractNavBlueprint();
	const decorative = extractDecorativeInfo();
	const responsive = extractResponsiveInfo(rules);

	const consistency = analyzeConsistency(colors, radii, shadows, spacingAnalysis);

	return {
		meta: {
			url: window.location.href,
			title: document.title,
			viewport: { w: window.innerWidth, h: window.innerHeight },
		},
		tokens: {
			colors, fonts, spacing, radii, shadows,
			...(spacingAnalysis ? { spacingAnalysis } : {}),
			...(scaleAnalysis ? { scaleAnalysis } : {}),
			...(consistency ? { consistency } : {}),
		},
		styles,
		structure,
		components,
		states,
		sections,
		contentPatterns,
		buttons,
		cards,
		nav,
		decorative,
		responsive,
	};
}

/** Top-level css rules from every same-origin-readable stylesheet. */
function readableRules(): CSSRule[] {
	const out: CSSRule[] = [];
	for (const sheet of Array.from(document.styleSheets)) {
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			continue; // Cross-origin stylesheet, not readable here.
		}
		for (const rule of Array.from(rules)) out.push(rule);
	}
	return out;
}
