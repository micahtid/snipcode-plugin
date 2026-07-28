/**
 * inspect/schema/sections.ts: measuring the page's top-level sections.
 *
 * Runs during the page-scoped inspect pass, against the live dom. A landing page is a sequence
 * of recognizable sections, and that sequence is most of what a redesign has to reproduce.
 *
 * The order of work is the point. Everything is measured here first, the layout from the
 * rendered boxes, the repeated items and their shape, the element catalog, the heading scale,
 * and only then does section-type.ts put a name on what those readings found. It never touches
 * the dom, so a guess can never outrank a measurement.
 *
 * The content-pattern pass at the bottom reports which element groupings recur across sections,
 * which is the page's compositional habit rather than any single section.
 */
import { classNameOf } from './classify';
import { contentRoot, hasDirectText, textLines } from './boxes';
import { readAlignment, readItems, readLayout } from './layout';
import { BUTTON_SELECTOR, effectiveBackground, isButtonLike, normalizeColor, paddingShorthand } from './shared';
import {
	classifySectionType, DEFAULT_BASE_FONT_PX, HEADLINE_RATIO, MAX_ITEM_FACTS, MAX_PRICE_LINES,
	SUBHEADING_RATIO, WHOLE_PAGE_SHARE, type SectionEvidence,
} from './section-type';
import type { ContentGrouping, SectionBlueprint } from './types';

/** How many sections one page reports, before the optimizer's own cap. */
const MAX_SECTIONS = 20;
/** How deep the element catalog walks, counted from the first content-bearing element. */
const MAX_CATALOG_DEPTH = 4;
/** How many catalogued element names one section reports. */
const MAX_CATALOG_ELEMENTS = 12;

/** Detects the page's top-level sections and each section's composition. */
export function extractSections(roots: Element[], navBar: Element | null): SectionBlueprint[] {
	const baseFontPx = parseFloat(window.getComputedStyle(document.body).fontSize) || DEFAULT_BASE_FONT_PX;
	const chosen = roots.slice(0, MAX_SECTIONS);
	const pageHeight = sectionExtent(chosen);
	const sections: SectionBlueprint[] = [];
	let heroClaimed = false;

	for (let index = 0; index < chosen.length; index++) {
		const el = chosen[index]!;
		const computed = window.getComputedStyle(el);
		const rect = el.getBoundingClientRect();
		const layout = readLayout(el);
		const items = readItems(layout);
		const catalog = catalogElements(el, baseFontPx);

		const evidence: SectionEvidence = {
			tag: el.tagName.toLowerCase(),
			rect,
			index,
			total: chosen.length,
			layout,
			alignment: readAlignment(el),
			items,
			itemFacts: (items?.items ?? []).slice(0, MAX_ITEM_FACTS).map((item) => ({
				shape: catalogElements(item, baseFontPx).elements,
				lines: textLines(item, MAX_PRICE_LINES),
			})),
			catalog: catalog.elements,
			headingPx: catalog.headingPx,
			baseFontPx,
			accordionCount: el.querySelectorAll('details').length,
			coversPage: pageHeight > 0 && rect.height >= pageHeight * WHOLE_PAGE_SHARE,
			isNavBar: el === navBar,
			heroClaimed,
			names: `${classNameOf(el)} ${(el.id || '').toLowerCase()}`,
		};

		const type = classifySectionType(evidence);
		if (type === 'hero') heroClaimed = true;

		const blueprint: SectionBlueprint = {
			type,
			tag: evidence.tag,
			layout: layout.pattern,
			layoutMeasured: layout.measured,
			alignment: evidence.alignment,
			background: readBackground(el, computed),
			elements: catalog.elements,
		};

		if (layout.columns >= 2) blueprint.gridColumns = layout.columns;
		if (layout.ratio) blueprint.columnRatio = layout.ratio;
		if (items) {
			blueprint.items = {
				count: items.count,
				width: items.width,
				height: items.height,
				shape: catalogElements(items.representative, baseFontPx).elements,
			};
		}

		const maxWidth = firstMaxWidth([el, layout.content, layout.container]);
		if (maxWidth) blueprint.maxWidth = maxWidth;

		// Gap belongs to the container that lays the columns out, not to the section wrapper,
		// which on a framework page declares no gap at all.
		const gapSource = layout.container ?? el;
		const gap = window.getComputedStyle(gapSource).gap;
		if (gap && gap !== 'normal' && gap !== '0px') blueprint.gap = gap;

		const padding = paddingShorthand(computed);
		if (padding !== '0px 0px 0px 0px') blueprint.padding = padding;

		sections.push(blueprint);
	}

	return sections;
}

/**
 * The color a section's content actually sits on.
 *
 * A gradient wins, since a hero painted as a gradient carries no background color at all and
 * calling that "transparent" said the section paints nothing while it painted the page's
 * brand. Otherwise it is the section's own color, or, when the section declares none, the
 * backdrop it inherits. A page that paints its background on a wrapper above every section
 * would otherwise report every one of them as transparent, which tells a redesign nothing.
 */
function readBackground(el: Element, computed: CSSStyleDeclaration): string {
	const image = computed.backgroundImage;
	if (image && image !== 'none' && image.includes('gradient(')) return image;
	return normalizeColor(computed.backgroundColor) || effectiveBackground(el);
}

/**
 * How tall the page is, measured from the sections themselves.
 *
 * Not from `scrollHeight`: a page that scrolls an inner element rather than the document leaves
 * both body and documentElement reporting the viewport height, and a live site doing exactly
 * that had its 1021px hero read as covering a "900px document". What the sections span is a
 * measurement no scroll arrangement can distort.
 */
function sectionExtent(roots: Element[]): number {
	let top = Infinity;
	let bottom = -Infinity;
	for (const el of roots) {
		const rect = el.getBoundingClientRect();
		top = Math.min(top, rect.top);
		bottom = Math.max(bottom, rect.bottom);
	}
	return bottom > top ? bottom - top : 0;
}

/** The first real max-width among a chain of candidates, or null when none constrains its width. */
function firstMaxWidth(candidates: Array<Element | null>): string | null {
	for (const el of candidates) {
		if (!el) continue;
		const value = window.getComputedStyle(el).maxWidth;
		if (value && value !== 'none') return value;
	}
	return null;
}

/** One element catalog: the ordered element names, plus the largest heading the walk saw. */
interface CatalogReading {
	elements: string[];
	headingPx: number;
}

/**
 * Catalogs the ordered, deduplicated semantic elements present in a section, and the size of its
 * largest heading.
 *
 * The walk starts at the section's first content-bearing element and does not spend depth on
 * single-child wrappers, so a framework build's chain of hashed divs no longer exhausts the
 * budget before the content. Heading size is reported alongside because the classifier needs the
 * section's type scale and re-querying for it would be a second, disagreeing measurement.
 */
function catalogElements(section: Element, baseFontPx: number): CatalogReading {
	const elements: string[] = [];
	const seen = new Set<string>();
	let headingPx = 0;
	const addOnce = (name: string): void => {
		if (!seen.has(name)) {
			elements.push(name);
			seen.add(name);
		}
	};
	const dropOnce = (name: string): void => {
		const index = elements.indexOf(name);
		if (index >= 0) elements.splice(index, 1);
		seen.delete(name);
	};

	const walk = (el: Element, depth: number): void => {
		if (depth > MAX_CATALOG_DEPTH) return;
		const tag = el.tagName.toLowerCase();
		const classList = classNameOf(el);

		if (/^h[1-6]$/.test(tag)) {
			// A heading tag rendered at body size is a heading to a parser and nothing to a
			// reader, so it enters the catalog as neither.
			const size = parseFloat(window.getComputedStyle(el).fontSize) || 0;
			headingPx = Math.max(headingPx, size);
			if (size >= baseFontPx * HEADLINE_RATIO) addOnce('heading');
			else if (size >= baseFontPx * SUBHEADING_RATIO) addOnce('subheading');
		} else if (tag === 'p') {
			addOnce('text');
		} else if (tag === 'img' || tag === 'picture' || tag === 'video') {
			addOnce('image');
		} else if (tag === 'button' || (tag === 'a' && isButtonLike(el))) {
			// A pair replaces the lone button by name, not by position: popping the last entry
			// removed whatever the walk had added most recently, which was rarely the button.
			const siblings = el.parentElement?.querySelectorAll(BUTTON_SELECTOR);
			if (siblings && siblings.length >= 2) {
				dropOnce('button');
				addOnce('button-pair');
			} else if (!seen.has('button-pair')) {
				addOnce('button');
			}
		} else if (tag === 'form' || tag === 'input') {
			addOnce('form');
		} else if (tag === 'nav') {
			addOnce('nav-links');
		} else if (tag === 'ul' || tag === 'ol') {
			addOnce('list');
		}

		if (/badge|chip|pill|tag/.test(classList)) addOnce('badge');
		if (/card/.test(classList) && !seen.has('card-grid')) {
			const siblingCards = el.parentElement?.querySelectorAll('[class*="card"]');
			if (siblingCards && siblingCards.length >= 2) addOnce('card-grid');
		}
		if (tag === 'svg' || /icon/.test(classList)) addOnce('icon');

		// A single-child wrapper is a step in a chain, not a level of structure, so descending
		// through it costs no depth. This is what keeps a deeply wrapped hero from cataloguing
		// as an empty list.
		const passthrough = el.children.length === 1 && !hasDirectText(el);
		const next = passthrough ? depth : depth + 1;
		for (let i = 0; i < el.children.length; i++) walk(el.children[i]!, next);
	};

	walk(contentRoot(section), 0);
	return { elements: elements.slice(0, MAX_CATALOG_ELEMENTS), headingPx };
}

/** Counts recurring element groupings, e.g. "heading+text+button-pair", across sections. */
export function extractContentPatterns(sections: SectionBlueprint[]): ContentGrouping[] {
	const patternCounts = new Map<string, { count: number; elements: string[] }>();
	for (const section of sections) {
		for (const p of findSubPatterns(section.elements)) {
			const key = p.join('+');
			const existing = patternCounts.get(key);
			if (existing) existing.count++;
			else patternCounts.set(key, { count: 1, elements: p });
		}
	}
	return Array.from(patternCounts.entries())
		.map(([pattern, data]) => ({ pattern, occurrences: data.count, elements: data.elements }))
		.filter((p) => p.occurrences >= 1)
		.sort((a, b) => b.occurrences - a.occurrences)
		.slice(0, 10);
}

/** Finds the meaningful sub-patterns within a section's element list. */
function findSubPatterns(elements: string[]): string[][] {
	const patterns: string[][] = [];
	const heading = elements.includes('heading') || elements.includes('subheading');
	const text = elements.includes('text');
	const button = elements.includes('button') || elements.includes('button-pair');
	const buttonName = elements.includes('button-pair') ? 'button-pair' : 'button';

	if (heading && text && button) patterns.push(['heading', 'text', buttonName]);
	else if (heading && text) patterns.push(['heading', 'text']);
	else if (heading && button) patterns.push(['heading', buttonName]);

	if (elements.includes('badge') && heading) patterns.push(['badge', 'heading']);
	if (elements.includes('icon') && heading && text) patterns.push(['icon', 'heading', 'text']);
	if (elements.includes('image') && heading) patterns.push(['image', 'heading', 'text']);

	return patterns;
}
