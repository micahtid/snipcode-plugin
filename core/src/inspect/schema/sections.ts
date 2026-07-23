/**
 * inspect/schema/sections.ts: the page's top-level sections and their recurring compositions
 *
 * Pipeline position: inspect, page-scoped. See inspect/schema/extract.ts for the whole pass.
 * Reads from DOM: document/window, including geometry. This runs live.
 * Writes to: nothing.
 *
 * Why this exists: a landing page is a sequence of recognizable sections, a hero, a features
 * grid, testimonials, pricing, a cta, and that sequence is most of what a redesign needs to
 * reproduce. Classification is deliberately layered: structure first, since a heading plus a
 * paragraph plus a button really is a hero, then class and id naming, then text content, so a
 * page with meaningless class names still classifies from what it actually contains. The
 * content-pattern pass at the bottom then reports which element groupings recur, which is the
 * page's compositional habit rather than any single section.
 */
import { classNameOf, isElementVisible, SKIP_TAGS } from './classify';
import { BUTTON_SELECTOR, isButtonLike, normalizeColor, paddingShorthand } from './shared';
import type { ContentGrouping, LayoutPattern, SectionBlueprint, SectionType } from './types';

/** Detects the page's top-level sections and each section's composition. */
export function extractSections(): SectionBlueprint[] {
	const candidates: Element[] = [];
	for (let i = 0; i < document.body.children.length; i++) {
		const el = document.body.children[i]!;
		if (SKIP_TAGS.has(el.tagName.toLowerCase())) continue;
		if (!isElementVisible(el)) continue;
		candidates.push(el);
	}
	const main = document.body.querySelector('main');
	if (main) {
		for (let i = 0; i < main.children.length; i++) {
			const el = main.children[i]!;
			if (SKIP_TAGS.has(el.tagName.toLowerCase())) continue;
			if (!isElementVisible(el)) continue;
			if (!candidates.includes(el)) candidates.push(el);
		}
	}

	const sections: SectionBlueprint[] = [];
	for (const el of candidates.slice(0, 20)) {
		const computed = window.getComputedStyle(el);
		const layout = detectLayoutPattern(el);
		const blueprint: SectionBlueprint = {
			type: classifySectionType(el),
			tag: el.tagName.toLowerCase(),
			layout,
			alignment: detectAlignment(computed),
			background: normalizeColor(computed.backgroundColor) || 'transparent',
			elements: catalogSectionElements(el),
		};

		if (layout.startsWith('grid-')) {
			const gridCols = computed.gridTemplateColumns;
			if (gridCols && gridCols !== 'none') blueprint.gridColumns = gridCols.split(/\s+/).filter((v) => v !== '').length;
		}

		if (computed.maxWidth && computed.maxWidth !== 'none') {
			blueprint.maxWidth = computed.maxWidth;
		} else {
			const firstChild = el.querySelector('[class*="container"], [class*="wrapper"], [class*="inner"]');
			if (firstChild) {
				const childMax = window.getComputedStyle(firstChild).maxWidth;
				if (childMax && childMax !== 'none') blueprint.maxWidth = childMax;
			}
		}

		if (computed.gap && computed.gap !== 'normal' && computed.gap !== '0px') blueprint.gap = computed.gap;
		const padding = paddingShorthand(computed);
		if (padding !== '0px 0px 0px 0px') blueprint.padding = padding;

		sections.push(blueprint);
	}

	return sections;
}

/** Classifies a section into a semantic type by structure, then class/id, then content. */
function classifySectionType(el: Element): SectionType {
	const tag = el.tagName.toLowerCase();
	const text = (el.textContent || '').toLowerCase().slice(0, 500);
	const combined = `${classNameOf(el)} ${(el.id || '').toLowerCase()}`;

	if (tag === 'nav') return 'nav';
	if (tag === 'footer') return 'footer';

	const headings = el.querySelectorAll('h1, h2, h3');
	const buttons = el.querySelectorAll(BUTTON_SELECTOR);
	const images = el.querySelectorAll('img');
	const cards = el.querySelectorAll('[class*="card"]');
	const paragraphs = el.querySelectorAll('p');

	const h1 = el.querySelector('h1');
	if (h1) {
		const h1Size = parseFloat(window.getComputedStyle(h1).fontSize || '0');
		if (h1Size >= 28 && paragraphs.length >= 1 && buttons.length >= 1) return 'hero';
	}

	if (cards.length >= 3) {
		const sampleCard = cards[0]!;
		if (sampleCard.querySelector('svg, img[src*="icon"], [class*="icon"]') && sampleCard.querySelector('h2, h3, h4') && sampleCard.querySelector('p')) return 'features';
	}

	if (cards.length >= 2) {
		const sampleCard = cards[0]!;
		const hasAvatar = sampleCard.querySelector('img[class*="avatar"], img[class*="photo"], img[src*="avatar"]');
		const hasQuote = sampleCard.querySelector('blockquote, p, [class*="quote"]');
		if ((hasAvatar || /[“”"]/.test(sampleCard.textContent || '')) && hasQuote) return 'testimonials';
	}

	if (cards.length >= 2) {
		const sampleCard = cards[0]!;
		const hasPriceIndicator = /\$|€|£|\/mo|\/yr|\/month|\/year|price/i.test(sampleCard.textContent || '');
		if (hasPriceIndicator && sampleCard.querySelector('ul, ol, [class*="feature"]') && sampleCard.querySelector(BUTTON_SELECTOR)) return 'pricing';
	}

	const hasAccordion = el.querySelectorAll('details, [class*="accordion"], [data-accordion]').length > 0;
	const questionMarks = (text.match(/\?/g) || []).length;
	if (hasAccordion || (questionMarks >= 3 && headings.length >= 3)) return 'faq';

	const numberElements = el.querySelectorAll('[class*="stat"], [class*="number"], [class*="count"], [class*="metric"]');
	const bigNumbers = text.match(/\d{2,}[+%kKmMbB]?/g);
	if ((numberElements.length >= 3 || (bigNumbers && bigNumbers.length >= 3)) && cards.length <= 1) return 'stats';

	if (images.length >= 4 && headings.length <= 1) {
		const avgHeight = Array.from(images).slice(0, 8).reduce((s, img) => s + img.getBoundingClientRect().height, 0) / Math.min(images.length, 8);
		if (avgHeight < 80) return 'logos';
	}

	if (headings.length <= 2 && buttons.length >= 1 && cards.length === 0 && images.length <= 1) {
		if (el.getBoundingClientRect().height < 400 && /start|try|join|sign|get|download|ready|contact/i.test(text)) return 'cta';
	}

	if (/hero|banner|jumbotron|splash/.test(combined)) return 'hero';
	if (/feature|benefit|capability/.test(combined)) return 'features';
	if (/how[-_]?it[-_]?works|steps|process/.test(combined)) return 'how-it-works';
	if (/testimon|review|quote/.test(combined)) return 'testimonials';
	if (/pricing|plans?|tier/.test(combined)) return 'pricing';
	if (/faq|question|accordion/.test(combined)) return 'faq';
	if (/cta|call[-_]?to[-_]?action|get[-_]?started|sign[-_]?up/.test(combined)) return 'cta';
	if (/stats?|numbers|metrics|counter/.test(combined)) return 'stats';
	if (/logo|partner|client|brand|trusted/.test(combined)) return 'logos';
	if (/gallery|portfolio|showcase/.test(combined)) return 'gallery';

	if (tag === 'header' || el.querySelector('h1')) {
		if (el === el.parentElement?.querySelector('section, header')) return 'hero';
	}
	if (/[“”"]/.test(text.slice(0, 300)) && cards.length >= 2) return 'testimonials';
	if (el.querySelectorAll('[class*="star"], [class*="rating"]').length > 0) return 'testimonials';
	if (cards.length >= 3 || (headings.length >= 3 && images.length >= 2)) return 'features';
	if (buttons.length >= 1 && headings.length <= 2 && /start|try|join|sign|get|download/.test(text)) return 'cta';

	return 'content';
}

/** Reads a section's layout pattern from its own or its inner container's flex/grid. */
function detectLayoutPattern(el: Element): LayoutPattern {
	const targets = [el];
	const inner = el.querySelector('[class*="container"], [class*="wrapper"], [class*="inner"], [class*="content"], [class*="grid"]');
	if (inner) targets.push(inner);

	for (const target of targets) {
		const computed = window.getComputedStyle(target);
		const display = computed.display;

		if (display === 'grid' || display === 'inline-grid') {
			const cols = computed.gridTemplateColumns;
			if (cols && cols !== 'none') {
				const colCount = cols.split(/\s+/).filter((v) => v && v !== '').length;
				if (colCount === 2) return 'grid-2';
				if (colCount === 3) return 'grid-3';
				if (colCount === 4) return 'grid-4';
				if (colCount > 4) return 'grid-n';
			}
		}

		if (display === 'flex' || display === 'inline-flex') {
			const direction = computed.flexDirection;
			if (direction === 'column' || direction === 'column-reverse') {
				if (computed.textAlign === 'center' || computed.alignItems === 'center') return 'centered-stack';
				return 'single-column';
			}
			if ((direction === 'row' || direction === 'row-reverse') && target.children.length === 2) {
				const first = target.children[0];
				const second = target.children[1];
				if (first && second) {
					const firstW = first.getBoundingClientRect().width;
					const secondW = second.getBoundingClientRect().width;
					const ratio = firstW / (firstW + secondW);
					if (ratio > 0.35 && ratio < 0.65) return direction === 'row-reverse' ? 'two-column-reverse' : 'two-column';
					return 'split';
				}
			}
		}
	}

	if (window.getComputedStyle(el).textAlign === 'center') return 'centered-stack';
	return 'single-column';
}

/** Reads a section's alignment from text-align / align-items. */
function detectAlignment(computed: CSSStyleDeclaration): 'left' | 'center' | 'right' {
	if (computed.textAlign === 'center' || computed.alignItems === 'center') return 'center';
	if (computed.textAlign === 'right' || computed.alignItems === 'flex-end') return 'right';
	return 'left';
}

/** Catalogs the ordered, deduplicated semantic elements present in a section. */
function catalogSectionElements(section: Element): string[] {
	const elements: string[] = [];
	const seen = new Set<string>();
	const addOnce = (name: string): void => {
		if (!seen.has(name)) {
			elements.push(name);
			seen.add(name);
		}
	};

	const walk = (el: Element, depth: number): void => {
		if (depth > 4) return;
		const tag = el.tagName.toLowerCase();
		const classList = classNameOf(el);

		if (/^h[1-6]$/.test(tag)) {
			addOnce(parseFloat(window.getComputedStyle(el).fontSize) >= 32 ? 'heading' : 'subheading');
		} else if (tag === 'p') {
			addOnce('text');
		} else if (tag === 'img' || tag === 'picture' || tag === 'video') {
			addOnce('image');
		} else if (tag === 'button' || (tag === 'a' && isButtonLike(el))) {
			addOnce('button');
			const siblings = el.parentElement?.querySelectorAll(BUTTON_SELECTOR);
			if (siblings && siblings.length >= 2 && !seen.has('button-pair')) {
				elements.pop(); // Replace the lone 'button' with 'button-pair'.
				seen.delete('button');
				addOnce('button-pair');
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

		for (let i = 0; i < el.children.length; i++) walk(el.children[i]!, depth + 1);
	};

	walk(section, 0);
	return elements.slice(0, 12);
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
	const hasHeading = elements.includes('heading') || elements.includes('subheading');
	const hasText = elements.includes('text');
	const hasButton = elements.includes('button') || elements.includes('button-pair');
	const buttonName = elements.includes('button-pair') ? 'button-pair' : 'button';

	if (hasHeading && hasText && hasButton) patterns.push(['heading', 'text', buttonName]);
	else if (hasHeading && hasText) patterns.push(['heading', 'text']);
	else if (hasHeading && hasButton) patterns.push(['heading', buttonName]);

	if (elements.includes('badge') && hasHeading) patterns.push(['badge', 'heading']);
	if (elements.includes('icon') && hasHeading && hasText) patterns.push(['icon', 'heading', 'text']);
	if (elements.includes('image') && hasHeading) patterns.push(['image', 'heading', 'text']);

	return patterns;
}
