/**
 * inspect/schema/walk.ts: the stratified dom walk every later pass reads.
 *
 * The sample is taken once, here. A naive walk of a long page spends its whole budget in the
 * first section, so the budget is split across the discovered sections in proportion to size.
 *
 * The sections come from discovery, not from body's children: on an app-root page body has one
 * child, which gave the whole page a single bucket and made the stratification do nothing.
 *
 * Depth counts levels of structure, not dom nodes. A framework build separates a section from
 * its content by a chain of single-child divs, and charging each link a level spends the whole
 * depth budget before the walk reaches anything worth recording.
 */
import { computeFingerprint } from './fingerprint';
import { classifyElement, isElementVisible, SKIP_TAGS } from './classify';
import { hasDirectText } from './boxes';
import { sectionFinder } from './discovery';
import { gradientStops, normalizeColor, type PseudoColor, type WalkedElement } from './shared';
import { isTransparentColor } from '../../utils/color';

/** Selectors for third-party widgets, such as chat, cookie, and analytics, to skip during the walk. */
const THIRD_PARTY_BLOCKLIST = [
	'[class*="intercom"]', '[id*="cookie"]', '[data-ad]', '[class*="grecaptcha"]',
	'[class*="hotjar"]', '[id*="onetrust"]', '[class*="drift"]', '[class*="hubspot"]',
	'[class*="crisp"]', '[id*="fb-root"]', '[class*="livechat"]', '[class*="zendesk"]',
	'[class*="tawk"]', '[id*="chatlio"]',
];

/** Elements the walk records in total, across every section. */
const MAX_ELEMENTS = 1500;
/** Levels of structure the walk records, wrapper chains not counted. */
const MAX_DEPTH = 6;
/** Smallest budget any one section gets, so a short section is never sampled down to nothing. */
const MIN_SECTION_BUDGET = 10;
/**
 * Extra share of its budget a section may spend on its over-budget tail sample. The tail is what
 * keeps a very long section from being represented only by its opening, and bounding it is what
 * stops that same section from eating the share belonging to the sections after it.
 */
const TAIL_SHARE = 0.25;

/**
 * Walks the visible dom, capturing each element's role, fingerprint, and tree
 * position. Sampling is stratified: each discovered section gets a share of the
 * element budget proportional to its size, so a long section cannot crowd out the
 * rest. Once a section exceeds its budget it is sampled every third element, up to
 * a bounded tail.
 */
export function walkDOM(sectionRoots: Element[]): WalkedElement[] {
	const elements: WalkedElement[] = [];

	const isThirdParty = (el: Element): boolean => {
		for (const selector of THIRD_PARTY_BLOCKLIST) {
			try {
				if (el.matches(selector)) return true;
			} catch {
				// Invalid selector, skip it.
			}
		}
		return el.ownerDocument !== document; // Inside an iframe.
	};

	// First pass: size each section so the budget can be split proportionally. The floors come
	// out of the pool before the split, so the shares plus their tails cannot sum past the cap
	// and leave the walk's global stop, rather than the split, deciding who gets sampled.
	const sized = sectionRoots.map((el) => ({ el, count: el.querySelectorAll('*').length }));
	const totalElements = sized.reduce((sum, sec) => sum + sec.count, 0);
	const pool = Math.max(0, MAX_ELEMENTS / (1 + TAIL_SHARE) - MIN_SECTION_BUDGET * sized.length);

	const sectionBudgets = new Map<Element, number>();
	for (const sec of sized) {
		const proportion = totalElements > 0 ? sec.count / totalElements : 1 / Math.max(1, sized.length);
		sectionBudgets.set(sec.el, MIN_SECTION_BUDGET + Math.round(pool * proportion));
	}

	const sectionSeen = new Map<Element, number>();
	const sectionRecorded = new Map<Element, number>();
	const findSection = sectionFinder(sectionRoots);

	const walk = (parent: Element, depth: number): void => {
		if (depth > MAX_DEPTH) return;

		for (let i = 0; i < parent.children.length; i++) {
			const el = parent.children[i]!;
			if (SKIP_TAGS.has(el.tagName.toLowerCase())) continue;
			if (isThirdParty(el)) continue;
			if (!isElementVisible(el)) continue;

			// A single-child wrapper is one step along a chain, not a level of structure.
			const next = el.children.length === 1 && !hasDirectText(el) ? depth : depth + 1;
			const section = findSection(el) || el;
			const seen = sectionSeen.get(section) || 0;
			const recorded = sectionRecorded.get(section) || 0;
			const budget = sectionBudgets.get(section) ?? MAX_ELEMENTS;

			// Over budget: keep descending but sample only every third element, and stop
			// recording once the tail allowance is spent.
			const overBudget = seen >= budget && (seen % 3 !== 0 || recorded >= budget * (1 + TAIL_SHARE));
			if (overBudget) {
				sectionSeen.set(section, seen + 1);
				walk(el, next);
				continue;
			}

			if (elements.length >= MAX_ELEMENTS) return;
			sectionSeen.set(section, seen + 1);
			sectionRecorded.set(section, recorded + 1);

			const { fingerprint, properties } = computeFingerprint(el);
			const walked: WalkedElement = {
				element: el,
				tag: el.tagName.toLowerCase(),
				role: classifyElement(el),
				fingerprint,
				properties,
				parent: parent === document.body ? null : parent,
				depth,
			};
			const pseudoColors = extractPseudoColors(el);
			if (pseudoColors.length > 0) walked.pseudoColors = pseudoColors;

			elements.push(walked);
			walk(el, next);
		}
	};

	walk(document.body, 0);
	return elements;
}

/** Colors painted by an element's ::before / ::after content, tagged with what they paint. */
function extractPseudoColors(el: Element): PseudoColor[] {
	const colors: PseudoColor[] = [];
	for (const pseudo of ['::before', '::after'] as const) {
		try {
			const style = window.getComputedStyle(el, pseudo);
			const content = style.content;
			if (!content || content === 'none' || content === '""' || content === "''" || content === '') continue;

			const bg = style.backgroundColor;
			if (bg && !isTransparentColor(bg)) {
				const normalized = normalizeColor(bg);
				if (normalized) colors.push({ value: normalized, group: 'background' });
			}
			for (const stop of gradientStops(style.backgroundImage)) colors.push({ value: stop, group: 'background' });
			const color = style.color;
			if (color && !isTransparentColor(color)) {
				const normalized = normalizeColor(color);
				if (normalized) colors.push({ value: normalized, group: 'text' });
			}
		} catch {
			// Cross-origin or unsupported pseudo, skip.
		}
	}
	return colors;
}
