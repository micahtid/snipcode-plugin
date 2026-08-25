/**
 * inspect/schema/extract.ts: the order the page-schema passes run in.
 *
 * This file is the order of operations and nothing else. Discovery finds the sections and the
 * walk samples them. tokens.ts collects the design values, states.ts lifts the interactive
 * rules, sections.ts and section-type.ts describe and name each section, and the blueprint and
 * page-language passes read the components. optimize.ts trims the result, and
 * cli/src/schema-md.ts renders it.
 *
 * The pass is async for one reason. A site serving its css cross-origin hands the page context
 * sheets it may not read, and the hover rules and breakpoints live in exactly those. Recovering
 * them goes through the Host, and Host calls are round trips.
 */
import { getHost } from '../../host';
import { walkDOM } from './walk';
import { discoverSections, findNavBar } from './discovery';
import {
	collectColors, collectFonts, collectRadii, collectShadows, collectSpacing, detectTypographyScale,
} from './tokens';
import { extractStates } from './states';
import { extractContentPatterns, extractSections } from './sections';
import { extractButtonBlueprints } from './blueprint-button';
import { extractCardBlueprints } from './blueprint-card';
import { extractNavBlueprint } from './blueprint-nav';
import { extractDecorativeInfo, extractResponsiveInfo } from './page-language';
import type { PageSchema } from './types';
import { readableRuleLists } from '../../utils/css-rules';

/** Builds the complete page schema from the live dom. */
export async function extractPageSchema(): Promise<PageSchema> {
	// Discovery runs first and once, so every later reading agrees on what a section is
	// instead of each deriving its own answer.
	const sectionRoots = discoverSections();
	const navBar = findNavBar(sectionRoots);
	const walked = walkDOM(sectionRoots);
	const rules = await allRules();

	const colors = collectColors(walked);
	const fonts = collectFonts(walked);
	const spacing = collectSpacing(walked);
	const radii = collectRadii(walked);
	const shadows = collectShadows(walked);

	const scaleAnalysis = detectTypographyScale(fonts);
	const states = extractStates(rules, walked);

	const sections = extractSections(sectionRoots, navBar);
	const contentPatterns = extractContentPatterns(sections);

	const buttons = extractButtonBlueprints(walked, states);
	const cards = extractCardBlueprints(walked, states);
	const nav = extractNavBlueprint(navBar);
	const decorative = extractDecorativeInfo(sectionRoots);
	const responsive = extractResponsiveInfo(rules, navBar);

	return {
		meta: {
			url: window.location.href,
			title: document.title,
			viewport: { w: window.innerWidth, h: window.innerHeight },
		},
		tokens: {
			colors, fonts, spacing, radii, shadows,
			...(scaleAnalysis ? { scaleAnalysis } : {}),
		},
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

/**
 * Every css rule on the page, from every stylesheet, at any nesting depth.
 *
 * Two things used to hide rules here, and both left the schema reporting no interactive states
 * and no breakpoints on a page with plenty. Cross-origin sheets were skipped, and are now
 * recovered through the Host and reparsed. And only each sheet's top level was read, which on
 * any build wrapping its output in `@layer` is an empty list.
 *
 * Grouping blocks flatten, but `@media` is kept whole. A media rule is itself the answer the
 * responsive pass wants, and descending into one would hand the state pass conditional rules
 * as though they always applied.
 */
async function allRules(): Promise<CSSRule[]> {
	const out: CSSRule[] = [];
	const unreadable: string[] = [];
	for (const rules of readableRuleLists(unreadable)) flatten(rules, out, 0);

	if (unreadable.length === 0) return out;
	for (const text of await recoverSheetTexts(unreadable)) {
		try {
			const sheet = new CSSStyleSheet();
			await sheet.replace(text);
			flatten(sheet.cssRules, out, 0);
		} catch {
			// Unparseable recovered text; the readable sheets still stand.
		}
	}
	return out;
}

/** How deep grouping blocks are unwrapped. Real sheets nest a level or two, never six. */
const MAX_RULE_DEPTH = 6;

/** Collects rules, unwrapping @layer / @supports / @container and keeping @media whole. */
function flatten(rules: CSSRuleList, out: CSSRule[], depth: number): void {
	for (const rule of Array.from(rules)) {
		out.push(rule);
		if (depth >= MAX_RULE_DEPTH) continue;
		if (rule instanceof CSSMediaRule) continue;
		const nested = (rule as CSSRule & { cssRules?: unknown }).cssRules;
		if (nested instanceof CSSRuleList) flatten(nested, out, depth + 1);
	}
}

/** Stylesheet text for hrefs the page could not read, over the protocol first, then by fetch. */
async function recoverSheetTexts(hrefs: string[]): Promise<string[]> {
	const texts: string[] = [];
	const remaining = new Set(hrefs);

	try {
		const res = await getHost().cdpStylesheets(hrefs);
		for (const sheet of res?.result?.sheets ?? []) {
			if (!sheet.text) continue;
			texts.push(sheet.text);
			remaining.delete(sheet.href);
		}
	} catch {
		// No host, or the protocol is busy. The fetch path below still applies.
	}

	for (const href of remaining) {
		try {
			const res = await getHost().fetchStylesheet(href);
			if (res?.ok && res.result?.text) texts.push(res.result.text);
		} catch {
			// Blocked or offline; this sheet stays unread.
		}
	}
	return texts;
}
