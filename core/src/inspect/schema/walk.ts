/**
 * inspect/schema/walk.ts: the stratified dom walk and its pattern dedup
 *
 * Pipeline position: inspect, page-scoped. See inspect/schema/extract.ts for the whole pass.
 * Reads from DOM: document/window. This runs live, so the whole page must be loaded.
 * Writes to: nothing. It returns the walked records.
 *
 * Why this exists: every later schema pass reads the same sample of the page, so the sample
 * is taken once, here. Sampling is the interesting part: a naive walk of a long page spends
 * its whole budget in the first section, so the budget is split across the top-level
 * sections in proportion to their size. The dedup pass at the bottom then collapses runs of
 * identical siblings, which is what keeps a fifty-row list from filling the structure tree.
 */
import { computeFingerprint } from './fingerprint';
import { classifyElement, isElementVisible, SKIP_TAGS } from './classify';
import { groupBy, isTransparentColor, normalizeColor, type WalkedElement } from './shared';
import type { ComponentPattern } from './types';

/** Selectors for third-party widgets, such as chat, cookie, and analytics, to skip during the walk. */
const THIRD_PARTY_BLOCKLIST = [
	'[class*="intercom"]', '[id*="cookie"]', '[data-ad]', '[class*="grecaptcha"]',
	'[class*="hotjar"]', '[id*="onetrust"]', '[class*="drift"]', '[class*="hubspot"]',
	'[class*="crisp"]', '[id*="fb-root"]', '[class*="livechat"]', '[class*="zendesk"]',
	'[class*="tawk"]', '[id*="chatlio"]',
];

/**
 * Walks the visible dom, capturing each element's role, fingerprint, and tree
 * position. Sampling is stratified: each top-level section gets a share of the
 * element budget proportional to its size, so a long section cannot crowd out the
 * rest. Once a section exceeds its budget it is sampled every third element.
 */
export function walkDOM(): WalkedElement[] {
	const elements: WalkedElement[] = [];
	const MAX_ELEMENTS = 1500;

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

	// First pass: size each top-level section so the budget can be split proportionally.
	const topSections: Array<{ el: Element; count: number }> = [];
	for (let i = 0; i < document.body.children.length; i++) {
		const child = document.body.children[i]!;
		if (SKIP_TAGS.has(child.tagName.toLowerCase())) continue;
		topSections.push({ el: child, count: child.querySelectorAll('*').length });
	}
	const totalElements = topSections.reduce((s, sec) => s + sec.count, 0);

	const sectionBudgets = new Map<Element, number>();
	for (const sec of topSections) {
		const proportion = totalElements > 0 ? sec.count / totalElements : 1 / topSections.length;
		sectionBudgets.set(sec.el, Math.max(10, Math.round(MAX_ELEMENTS * proportion)));
	}

	const sectionCounts = new Map<Element, number>();
	const findTopSection = (el: Element): Element | null => {
		let current: Element | null = el;
		while (current && current.parentElement !== document.body) current = current.parentElement;
		return current;
	};

	const walk = (parent: Element, depth: number): void => {
		if (depth > 6) return;

		for (let i = 0; i < parent.children.length; i++) {
			const el = parent.children[i]!;
			if (SKIP_TAGS.has(el.tagName.toLowerCase())) continue;
			if (isThirdParty(el)) continue;
			if (!isElementVisible(el)) continue;

			const topSection = findTopSection(el) || el;
			const currentCount = sectionCounts.get(topSection) || 0;
			const budget = sectionBudgets.get(topSection) || MAX_ELEMENTS;

			// Over budget: keep descending but sample only every third element.
			if (currentCount >= budget && currentCount % 3 !== 0) {
				sectionCounts.set(topSection, currentCount + 1);
				walk(el, depth + 1);
				continue;
			}

			if (elements.length >= MAX_ELEMENTS) return;
			sectionCounts.set(topSection, currentCount + 1);

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
			walk(el, depth + 1);
		}
	};

	walk(document.body, 0);
	return elements;
}

/** Colors painted by an element's ::before / ::after content, when it has content. */
function extractPseudoColors(el: Element): string[] {
	const colors: string[] = [];
	for (const pseudo of ['::before', '::after'] as const) {
		try {
			const style = window.getComputedStyle(el, pseudo);
			const content = style.content;
			if (!content || content === 'none' || content === '""' || content === "''" || content === '') continue;

			const bg = style.backgroundColor;
			if (bg && !isTransparentColor(bg)) {
				const normalized = normalizeColor(bg);
				if (normalized) colors.push(normalized);
			}
			const color = style.color;
			if (color && !isTransparentColor(color)) {
				const normalized = normalizeColor(color);
				if (normalized) colors.push(normalized);
			}
		} catch {
			// Cross-origin or unsupported pseudo, skip.
		}
	}
	return colors;
}

/**
 * Groups elements by role+fingerprint to find repeated component patterns, meaning
 * 3+ of a non-generic role, and produces a run-length-collapsed list where consecutive
 * identical elements carry a `repeat` count instead of repeating.
 */
export function detectPatterns(walked: WalkedElement[]): { deduplicated: WalkedElement[]; components: ComponentPattern[] } {
	const groups = groupBy(walked, (el) => `${el.role}:${el.fingerprint}`);

	const components: ComponentPattern[] = [];
	for (const group of groups.values()) {
		const rep = group[0]!;
		if (group.length >= 3 && rep.role !== 'generic' && rep.role !== 'text') {
			components.push({
				name: `${rep.role}-pattern`,
				role: rep.role,
				count: group.length,
				structure: { tag: rep.tag, role: rep.role },
			});
		}
	}

	const deduplicated: WalkedElement[] = [];
	let prevKey = '';
	let repeatCount = 0;
	for (const el of walked) {
		const key = `${el.role}:${el.fingerprint}`;
		if (key === prevKey && deduplicated.length > 0) {
			repeatCount++;
		} else {
			if (repeatCount > 0 && deduplicated.length > 0) deduplicated[deduplicated.length - 1]!.repeat = repeatCount + 1;
			deduplicated.push(el);
			repeatCount = 0;
		}
		prevKey = key;
	}
	if (repeatCount > 0 && deduplicated.length > 0) deduplicated[deduplicated.length - 1]!.repeat = repeatCount + 1;

	return { deduplicated, components };
}
