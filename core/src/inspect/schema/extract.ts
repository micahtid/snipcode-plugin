/**
 * inspect/schema/extract.ts: the page-schema extractor
 *
 * Pipeline position: inspect, page-scoped. This is the whole pass; the others are its steps.
 * Reads from DOM: document/window. This runs live, so the whole page must be loaded.
 * Writes to: nothing. It returns a PageSchema.
 *
 * Why this exists: the schema inspector turns a whole page into a compressed design-system
 * schema. It walks the visible dom, stratified by section so a long page samples evenly,
 * collects the color, font, spacing, radius, and shadow tokens, lifts interactive-state rules
 * from the readable stylesheets, and detects section blueprints and the button, card, and nav
 * component blueprints plus the page's decorative and responsive language. The result is
 * size-reduced in optimize.ts and rendered for the reader in cli/src/schema-md.ts.
 *
 * This file is the order of operations and nothing else. Each pass lives in its own module:
 * the sample in walk.ts, the design tokens in tokens.ts, the state rules in states.ts, the
 * section reading in sections.ts, and the component and page-language specs in blueprints.ts.
 * Anything two passes both need is in shared.ts.
 *
 * The pass is async for one reason: a site that serves its css cross-origin hands the page
 * context stylesheets it may not read, and the hover rules and breakpoints live in exactly
 * those sheets. Recovering them goes through the Host, the same seam the extract pipeline
 * already uses for the same problem, and Host calls are round trips.
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

/** Builds the complete page schema from the live dom. */
export async function extractPageSchema(): Promise<PageSchema> {
	// Discovery runs first and once. The walk stratifies its budget over these sections, the
	// section pass describes them, the nav bar is scored among them, and the decorative pass
	// says which one each effect was seen in, so every reading agrees on what a section is
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
 * Two things used to hide rules from this pass, and both left the schema reporting that a page
 * had no interactive states and no breakpoints when it had plenty. Cross-origin sheets were
 * skipped; they are now recovered through the Host, the same seam capture/cdp.ts already uses,
 * and reparsed into a constructable stylesheet that never touches the live page. And only the
 * top level of each sheet was read, which on any build that wraps its output in `@layer`, the
 * shape every current utility framework emits, is an empty list.
 *
 * Grouping blocks are flattened; `@media` is kept whole. A media rule is itself the answer the
 * responsive pass is looking for, and descending into one would hand the state pass rules that
 * apply only under a condition as though they always applied.
 */
async function allRules(): Promise<CSSRule[]> {
	const out: CSSRule[] = [];
	const unreadable: string[] = [];

	for (const sheet of Array.from(document.styleSheets)) {
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			if (sheet.href) unreadable.push(sheet.href);
			continue;
		}
		flatten(rules, out, 0);
	}

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
