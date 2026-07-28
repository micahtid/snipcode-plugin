/**
 * core/src/candidates.ts: the element inventory for agent-driven targeting.
 *
 * The extension had a human click the element to snip. An agent has no cursor, so
 * candidates walks the page and returns a durable, selector-addressable inventory of
 * everything worth targeting: interactive controls, headings, landmarks, and the
 * representative of each repeated structural block (cards, nav items, list rows).
 *
 * Every candidate carries a churn-resistant css selector plus the text and rect it
 * had at harvest time. That recorded pair is what makes the flow stateless: extract
 * relaunches the browser, re-resolves the selector, and verifies the match against
 * this recorded text/rect before it snips, so a shifted page fails loudly instead of
 * extracting the wrong node. Rects are document-absolute (scroll offset folded in) so
 * they line up with the full-page screenshot the runner captures alongside.
 */
import { buildElementMetadata } from './capture/dom';
import { classifyElement, isElementVisible, SKIP_TAGS, type SemanticRole } from './inspect/schema/classify';

/** A box in document-absolute coordinates: viewport rect plus the page scroll offset. */
export interface CandidateRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** One targetable element, addressable by a durable selector and verifiable by text/rect. */
export interface Candidate {
	/** Stable within one inventory: c1, c2, ... */
	id: string;
	/** Churn-resistant selector, the one extract should re-resolve. */
	selector: string;
	/** Shortest-unique selector, a fallback when the durable one is over-specific. */
	shortSelector: string;
	tag: string;
	role: SemanticRole;
	/** Trimmed visible text, capped, or null when the element carries none. */
	text: string | null;
	ariaLabel: string | null;
	rect: CandidateRect;
	/** Count of same-signature siblings when this is the representative of a repeated block. */
	repeat?: number;
}

/** A major page region: header, nav, main, footer, hero, and the like. */
export interface Landmark {
	role: string;
	selector: string;
	rect: CandidateRect;
}

/** The full inventory candidates returns to the runner. */
export interface CandidateInventory {
	viewport: { width: number; height: number; devicePixelRatio: number };
	landmarks: Landmark[];
	candidates: Candidate[];
}

/** Interactive controls an agent is most likely to target. */
const INTERACTIVE = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [onclick], [tabindex="0"]';
/** Semantic + ARIA landmarks, mapped to a friendly region name. */
const LANDMARK_ROLES: Array<[string, string]> = [
	['header, [role="banner"]', 'banner'],
	['nav, [role="navigation"]', 'nav'],
	['main, [role="main"]', 'main'],
	['footer, [role="contentinfo"]', 'footer'],
	['aside, [role="complementary"]', 'aside'],
];
/** Hard cap so the inventory stays a manageable json payload for the agent. */
const MAX_CANDIDATES = 160;
/** A repeated-sibling group must reach this size to be collapsed to one representative. */
const MIN_REPEAT = 3;
/** Longest text snippet carried per candidate. */
const TEXT_CAP = 80;

/** Document-absolute rect for an element, folding in the current scroll offset. */
export function rectOf(el: Element): CandidateRect {
	const r = el.getBoundingClientRect();
	return {
		x: Math.round(r.left + window.scrollX),
		y: Math.round(r.top + window.scrollY),
		w: Math.round(r.width),
		h: Math.round(r.height),
	};
}

/** Loose text of an element, normalized for comparison against a recorded snippet. */
export function normalizedText(el: Element): string {
	return ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/s+/g, ' ').trim();
}

/** Trimmed, capped visible text, or null when the element carries none worth recording. */
function textOf(el: Element): string | null {
	const raw = (el as HTMLElement).innerText ?? el.textContent ?? '';
	const text = raw.replace(/\s+/g, ' ').trim();
	if (!text) return null;
	return text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}…` : text;
}

/** Structural signature for repeat detection: tag plus sorted class list. */
function signatureOf(el: Element): string {
	const classes = [...el.classList].sort().join('.');
	return `${el.tagName.toLowerCase()}#${classes}`;
}

/**
 * Marks the representative of each repeated structural block with a sibling count. A
 * block is >= MIN_REPEAT direct children of one parent that share a structural
 * signature: the card grid, the nav list, the pricing tiers. Only the first of each
 * group survives into the inventory, tagged with how many it stands for, so the agent
 * sees "one card, repeated 6 times" rather than six near-identical entries.
 */
function repeatCounts(elements: Set<Element>): Map<Element, number> {
	const bySignature = new Map<string, Element[]>();
	const parents = new Set<Element>();
	for (const el of elements) if (el.parentElement) parents.add(el.parentElement);
	for (const parent of parents) {
		const groups = new Map<string, Element[]>();
		for (const child of parent.children) {
			if (!elements.has(child)) continue;
			const sig = signatureOf(child);
			const group = groups.get(sig) ?? [];
			group.push(child);
			groups.set(sig, group);
		}
		for (const [sig, group] of groups) if (group.length >= MIN_REPEAT) bySignature.set(sig, group);
	}
	// First member of each qualifying group carries the count; the rest are dropped.
	const counts = new Map<Element, number>();
	const dropped = new Set<Element>();
	for (const group of bySignature.values()) {
		const [first, ...rest] = group;
		if (!first) continue;
		counts.set(first, group.length);
		for (const el of rest) dropped.add(el);
	}
	for (const el of dropped) elements.delete(el);
	return counts;
}

/** Collects the raw set of harvest-worthy elements: interactive, headings, landmarks, cards. */
function collectElements(): Set<Element> {
	const out = new Set<Element>();
	const add = (el: Element) => {
		const tag = el.tagName.toLowerCase();
		if (SKIP_TAGS.has(tag)) return;
		if (!isElementVisible(el)) return;
		out.add(el);
	};
	for (const el of document.querySelectorAll(INTERACTIVE)) add(el);
	for (const el of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) add(el);
	for (const [selector] of LANDMARK_ROLES) for (const el of document.querySelectorAll(selector)) add(el);
	// Cards and repeated blocks: any visible element that classifies as a card.
	for (const el of document.querySelectorAll('div, section, article, li')) {
		if (out.has(el)) continue;
		const tag = el.tagName.toLowerCase();
		if (SKIP_TAGS.has(tag) || !isElementVisible(el)) continue;
		if (classifyElement(el) === 'card') out.add(el);
	}
	return out;
}

/** The page landmarks, first match of each region wins. */
function collectLandmarks(): Landmark[] {
	const out: Landmark[] = [];
	const seen = new Set<Element>();
	for (const [selector, role] of LANDMARK_ROLES) {
		const el = document.querySelector(selector);
		if (!el || seen.has(el) || !isElementVisible(el)) continue;
		seen.add(el);
		out.push({ role, selector: buildElementMetadata(el).robustSelector, rect: rectOf(el) });
	}
	return out;
}

/**
 * Walks the page and returns the targeting inventory. Pure in-page dom work: no host
 * calls, no capture, so it is cheap enough to run on every candidates invocation.
 */
export function harvestCandidates(): CandidateInventory {
	const elements = collectElements();
	const counts = repeatCounts(elements);

	// Order by document position so ids read top-to-bottom, matching the screenshot.
	const ordered = [...elements].sort((a, b) => {
		const cmp = a.compareDocumentPosition(b);
		if (cmp & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
		if (cmp & Node.DOCUMENT_POSITION_PRECEDING) return 1;
		return 0;
	});

	const candidates: Candidate[] = [];
	let n = 0;
	for (const el of ordered) {
		if (candidates.length >= MAX_CANDIDATES) break;
		const meta = buildElementMetadata(el);
		const repeat = counts.get(el);
		candidates.push({
			id: `c${++n}`,
			selector: meta.robustSelector,
			shortSelector: meta.selector,
			tag: el.tagName.toLowerCase(),
			role: classifyElement(el),
			text: textOf(el),
			ariaLabel: el.getAttribute('aria-label'),
			rect: rectOf(el),
			...(repeat && repeat > 1 ? { repeat } : {}),
		});
	}

	return {
		viewport: {
			width: window.innerWidth,
			height: window.innerHeight,
			devicePixelRatio: window.devicePixelRatio || 1,
		},
		landmarks: collectLandmarks(),
		candidates,
	};
}
