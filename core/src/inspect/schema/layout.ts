/**
 * inspect/schema/layout.ts: a section's layout, alignment, and repetition, read from its boxes.
 *
 * Runs during the page-scoped inspect pass, against the live dom. Reading `display: grid` off a
 * section only works when the section element is the grid, which framework builds almost never
 * do. The real grid sits several hashed-class divs deeper, so the read falls through to a
 * default and every section comes back the same wrong shape. Clustering the rendered children
 * by the rows they occupy has no such blind spot.
 *
 * The container that actually divides horizontally is chosen by size, so a two-button strip
 * inside a stacked hero cannot pass itself off as the hero's layout.
 *
 * Every reading says whether it was measured. A section painting no box reports `unknown`
 * rather than a default, because a confident wrong answer costs more than an honest gap.
 */
import {
	contentChildren, contentRoot, elementChildren, median, rowsOf, scanContainers,
	MAX_LINE_CHARS, MIN_BOX_PX, OVERFLOW_SLACK_PX,
} from './boxes';
import type { LayoutPattern } from './types';

/** A nested container must be this wide, and this large, relative to the section to be its layout. */
const MIN_CONTAINER_WIDTH_SHARE = 0.5;
const MIN_CONTAINER_AREA_SHARE = 0.25;
/** Wider than this share of the section and the container is a track, not a row of columns. */
const MAX_CONTAINER_WIDTH_SHARE = 1.05;
/** Column-width ratios inside this band read as a balanced two-column split rather than a sidebar. */
const BALANCED_RATIO_MIN = 0.35;
const BALANCED_RATIO_MAX = 0.65;
/** Slack, in px, when comparing a child's left and right gaps to call it centered. */
const CENTERING_SLACK_PX = 3;
/** Share of children that must read as centered for the container to count as centered. */
const CENTERED_SHARE = 0.6;
/** Fewest similar boxes in a run before it reads as repetition rather than as two or three parts. */
const MIN_REPEAT_ITEMS = 3;
/** How far from the median an item's width and height may sit and still belong to the run. */
const ITEM_SIZE_TOLERANCE = 0.35;
/** How many of a run's items are fingerprinted when checking for a duplicated marquee track. */
const MAX_DUPLICATE_PROBES = 60;

/** One section's measured layout, plus the container the measurement came from. */
export interface LayoutReading {
	pattern: LayoutPattern;
	/** False means nothing was measurable; pattern is then 'unknown' and must render as unknown. */
	measured: boolean;
	/** Columns counted across the widest row. 0 when unmeasured. */
	columns: number;
	/** Width split of a two-column row, e.g. "58/42". Only set for a single row of two. */
	ratio?: string;
	/** The container whose children were clustered, for the caller's gap / max-width reads. */
	container: Element | null;
	/** The section's first content-bearing element, wrapper chain already skipped. */
	content: Element;
}

/** One section's repeated items: how many, how big one is, and which one stands in for them. */
export interface ItemsReading {
	/** Items in the dom, not the visible subset, with a duplicated marquee track collapsed. */
	count: number;
	/** The representative item's box, rounded, which is the size a rebuild has to reproduce. */
	width: number;
	height: number;
	/** The measured items themselves, so a caller can read the run's own shape and text. */
	items: Element[];
	representative: Element;
}

/** True when a container's children are visually centered inside it, by declaration or by gaps. */
function isCentered(container: Element, kids: Element[]): boolean {
	const computed = window.getComputedStyle(container);
	if (computed.textAlign === 'center') return true;

	const rect = container.getBoundingClientRect();
	if (kids.length === 0 || rect.width <= 0) return false;
	let centered = 0;
	for (const kid of kids) {
		const kidRect = kid.getBoundingClientRect();
		const left = kidRect.left - rect.left;
		const right = rect.right - kidRect.right;
		if (left > CENTERING_SLACK_PX && Math.abs(left - right) <= CENTERING_SLACK_PX) centered++;
	}
	return centered / kids.length >= CENTERED_SHARE;
}

/** True when a container's children hug its right edge. */
function isRightAligned(container: Element, kids: Element[]): boolean {
	const computed = window.getComputedStyle(container);
	if (computed.textAlign === 'right' || computed.textAlign === 'end') return true;

	const rect = container.getBoundingClientRect();
	if (kids.length === 0 || rect.width <= 0) return false;
	let hugging = 0;
	for (const kid of kids) {
		const kidRect = kid.getBoundingClientRect();
		const left = kidRect.left - rect.left;
		const right = rect.right - kidRect.right;
		if (right <= CENTERING_SLACK_PX && left > CENTERING_SLACK_PX * 2) hugging++;
	}
	return hugging / kids.length >= CENTERED_SHARE;
}

/**
 * A section's alignment, read from the container holding its content. The section wrapper's
 * own text-align says nothing about where that content sits.
 */
export function readAlignment(section: Element): 'left' | 'center' | 'right' {
	const content = contentRoot(section);
	const kids = contentChildren(content);
	if (isCentered(content, kids)) return 'center';
	if (isRightAligned(content, kids)) return 'right';
	return 'left';
}

/** True when the container scrolls horizontally, which is a layout of its own. */
function scrollsHorizontally(el: Element): boolean {
	const computed = window.getComputedStyle(el);
	const overflowX = computed.overflowX;
	if (overflowX !== 'auto' && overflowX !== 'scroll') return false;
	return el.scrollWidth > el.clientWidth + MIN_BOX_PX;
}

/** True when a row's children paint outside their container's box, which is a track, not columns. */
function overflowsHorizontally(container: Element, rows: Element[][]): boolean {
	const rect = container.getBoundingClientRect();
	for (const row of rows) {
		const first = row[0];
		const last = row[row.length - 1];
		if (!first || !last) continue;
		if (last.getBoundingClientRect().right > rect.right + OVERFLOW_SLACK_PX) return true;
		if (first.getBoundingClientRect().left < rect.left - OVERFLOW_SLACK_PX) return true;
	}
	return false;
}

/** True when the first child in dom order sits to the right of the second, i.e. a reversed row. */
function isReversed(row: Element[], domOrder: Element[]): boolean {
	if (row.length !== 2) return false;
	const firstInDom = domOrder.indexOf(row[0]!) > domOrder.indexOf(row[1]!);
	return firstInDom;
}

/** Names a column count as a grid pattern. */
function gridPattern(columns: number): LayoutPattern {
	if (columns === 2) return 'grid-2';
	if (columns === 3) return 'grid-3';
	if (columns === 4) return 'grid-4';
	return 'grid-n';
}

/**
 * Measures a section's layout from its rendered boxes. The content root is always a candidate,
 * so a section dividing at its top level is read there. When it stacks instead, the largest
 * nested container that divides horizontally and is a substantial part of the section wins.
 * That finds a features grid under a heading without mistaking a hero's button strip for one.
 */
export function readLayout(section: Element): LayoutReading {
	const content = contentRoot(section);
	const base = content.getBoundingClientRect();
	const baseArea = base.width * base.height;
	const rootKids = contentChildren(content);

	if (rootKids.length === 0) {
		// A bare run of text is a measured single column. Nothing at all is not: that section
		// has no layout to report, and "single-column" there is the silent fallback.
		if ((content.textContent || '').trim() === '') {
			return { pattern: 'unknown', measured: false, columns: 0, container: null, content };
		}
		const pattern: LayoutPattern = isCentered(content, []) ? 'centered-stack' : 'single-column';
		return { pattern, measured: true, columns: 1, container: content, content };
	}

	let best: { el: Element; kids: Element[]; rows: Element[][]; columns: number; area: number } | null = null;
	let track: Element | null = null;
	for (const candidate of scanContainers(content)) {
		const kids = contentChildren(candidate);
		const rect = candidate.getBoundingClientRect();
		if (candidate !== content) {
			if (base.width > 0 && rect.width < base.width * MIN_CONTAINER_WIDTH_SHARE) continue;
			// A container wider than its section is a track scrolled through a window, not a
			// row of columns. Counted as columns, a logo marquee came back as a 56-column
			// grid: true of the boxes, useless as a layout.
			if (base.width > 0 && rect.width > base.width * MAX_CONTAINER_WIDTH_SHARE) {
				if (kids.length >= 2) track = candidate;
				continue;
			}
			if (baseArea > 0 && rect.width * rect.height < baseArea * MIN_CONTAINER_AREA_SHARE) continue;
		}
		const rows = rowsOf(kids);
		const columns = Math.max(...rows.map((row) => row.length));
		if (columns < 2) continue;
		const area = rect.width * rect.height;
		if (!best || area > best.area) best = { el: candidate, kids, rows, columns, area };
	}

	if (!best) {
		if (track) return { pattern: 'horizontal-scroll', measured: true, columns: 1, container: track, content };
		if (scrollsHorizontally(content)) {
			return { pattern: 'horizontal-scroll', measured: true, columns: 1, container: content, content };
		}
		const pattern: LayoutPattern = isCentered(content, rootKids) ? 'centered-stack' : 'single-column';
		return { pattern, measured: true, columns: 1, container: content, content };
	}

	if (scrollsHorizontally(best.el) || overflowsHorizontally(best.el, best.rows)) {
		return { pattern: 'horizontal-scroll', measured: true, columns: best.columns, container: best.el, content };
	}

	const singleRow = best.rows.length === 1;
	if (singleRow && best.columns === 2) {
		const [first, second] = best.rows[0]!;
		const firstWidth = first!.getBoundingClientRect().width;
		const secondWidth = second!.getBoundingClientRect().width;
		const total = firstWidth + secondWidth;
		const share = total > 0 ? firstWidth / total : 0.5;
		const ratio = `${Math.round(share * 100)}/${100 - Math.round(share * 100)}`;
		const balanced = share > BALANCED_RATIO_MIN && share < BALANCED_RATIO_MAX;
		const reversed = isReversed(best.rows[0]!, best.kids);
		const pattern: LayoutPattern = balanced ? (reversed ? 'two-column-reverse' : 'two-column') : 'split';
		return { pattern, measured: true, columns: 2, ratio, container: best.el, content };
	}

	return { pattern: gridPattern(best.columns), measured: true, columns: best.columns, container: best.el, content };
}

/**
 * Measures a section's repetition: the run of similar boxes inside the container its layout
 * came from.
 *
 * A label alone is useless. "logos, horizontal-scroll" tells an agent nothing it can rebuild,
 * so it invents a layout; fifteen boxes of 120x36 tells it what to draw. Similarity is judged
 * by size against the median, never by class name, so a hashed build reads like a hand-written
 * one.
 */
export function readItems(layout: LayoutReading): ItemsReading | null {
	const container = layout.container;
	if (!container) return null;

	const kids = elementChildren(container);
	const boxed = kids
		.map((el) => ({ el, rect: el.getBoundingClientRect() }))
		.filter((b) => b.rect.width >= MIN_BOX_PX && b.rect.height >= MIN_BOX_PX);
	if (boxed.length < MIN_REPEAT_ITEMS) return null;

	const midWidth = median(boxed.map((b) => b.rect.width));
	const midHeight = median(boxed.map((b) => b.rect.height));
	const similar = boxed.filter((b) => nearMedian(b.rect.width, midWidth) && nearMedian(b.rect.height, midHeight));
	if (similar.length < MIN_REPEAT_ITEMS) return null;

	const representative = similar
		.slice()
		.sort((a, b) => sizeDistance(a.rect, midWidth, midHeight) - sizeDistance(b.rect, midWidth, midHeight))[0]!;
	const items = similar.map((s) => s.el);

	// A carousel's off-slide panels still belong to the run: the count is what the dom carries,
	// not what this viewport happens to show.
	const shown = new Set(items);
	const hidden = kids.filter((el) => !shown.has(el) && el.tagName === representative.el.tagName).length;

	return {
		count: distinctRunLength(items) + hidden,
		width: Math.round(representative.rect.width),
		height: Math.round(representative.rect.height),
		items,
		representative: representative.el,
	};
}

/**
 * How many distinct items a run holds. A seamless marquee duplicates its whole run so the loop
 * has no visible seam, so a raw count reports twice the logos the page shows. When the sequence
 * exactly repeats its own first half, that half is the run: a property of the data, read off
 * the items, not a rule about marquees.
 */
function distinctRunLength(items: Element[]): number {
	if (items.length < 2 || items.length % 2 !== 0 || items.length > MAX_DUPLICATE_PROBES) return items.length;
	const half = items.length / 2;
	for (let i = 0; i < half; i++) {
		if (itemFingerprint(items[i]!) !== itemFingerprint(items[i + half]!)) return items.length;
	}
	return half;
}

/** What one item is, for comparing two of them: its tag, its box, and the content it carries. */
function itemFingerprint(el: Element): string {
	const rect = el.getBoundingClientRect();
	const image = el.tagName.toLowerCase() === 'img' ? el : el.querySelector('img');
	return [
		el.tagName.toLowerCase(),
		Math.round(rect.width),
		Math.round(rect.height),
		(el.textContent || '').trim().slice(0, MAX_LINE_CHARS),
		(image?.getAttribute('src') ?? '').slice(-MAX_LINE_CHARS),
	].join('|');
}

/** True when a measurement sits within the run's tolerance of the median. */
function nearMedian(value: number, mid: number): boolean {
	return mid > 0 && Math.abs(value - mid) <= mid * ITEM_SIZE_TOLERANCE;
}

/** How far a box sits from the run's median box, relative, so both axes count equally. */
function sizeDistance(rect: DOMRect, midWidth: number, midHeight: number): number {
	const dw = midWidth > 0 ? Math.abs(rect.width - midWidth) / midWidth : 0;
	const dh = midHeight > 0 ? Math.abs(rect.height - midHeight) / midHeight : 0;
	return dw + dh;
}
