/**
 * inspect/schema/geometry.ts: layout read from the rendered boxes
 *
 * Pipeline position: inspect, page-scoped. See inspect/schema/extract.ts for the whole pass.
 * Reads from DOM: element geometry and computed styles, live.
 * Writes to: nothing. Every function returns a reading.
 *
 * Why this exists: a section's layout is what the page paints, not what its wrapper divs
 * declare. Reading `display: grid` off a section element only works when the section element
 * is the grid, which framework builds almost never do: they nest the real grid several
 * hashed-class divs deeper, so a style read falls through to a default and every section
 * comes back the same wrong shape. Geometry has no such blind spot. Cluster a container's
 * children by the rows they occupy and the column count is simply the widest row, whatever
 * css produced it.
 *
 * Two moves make that reliable. Wrapper chains are collapsed first, so a walk that starts at
 * a section reaches its content instead of exhausting its depth budget on single-child divs.
 * Then the container whose children actually divide horizontally is chosen by size, so a
 * two-button strip inside a stacked hero cannot pass itself off as the hero's layout: it is
 * neither wide enough nor large enough relative to the section to qualify.
 *
 * Every reading says whether it was measured. A section whose content has no rendered boxes
 * reports `unknown`, never a default, because the schema is a hard contract and a confident
 * wrong answer costs more than an honest gap.
 *
 * Section discovery and the nav-bar scorer live here too. Both are geometric readings, both are
 * needed by more than one pass, and keeping them where the section pass used to hold them would
 * mean walk.ts importing sections.ts, which is a cycle.
 */
import { isElementVisible, SKIP_TAGS } from './classify';
import type { LayoutPattern } from './types';

/** Smallest box, in px, that counts as rendered content rather than a hairline or a spacer. */
const MIN_BOX_PX = 4;
/** How many single-child wrappers to skip before giving up. Framework chains are long but finite. */
const MAX_UNWRAP = 12;
/** Bounds on the container scan, so a section with thousands of nodes cannot stall the pass. */
const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_NODES = 300;
/** A nested container must be this wide, and this large, relative to the section to be its layout. */
const MIN_CONTAINER_WIDTH_SHARE = 0.5;
const MIN_CONTAINER_AREA_SHARE = 0.25;
/** Wider than this share of the section and the container is a track, not a row of columns. */
const MAX_CONTAINER_WIDTH_SHARE = 1.05;
/** Slack, in px, before a child painting past its container's edge counts as overflow. */
const OVERFLOW_SLACK_PX = 8;
/** Two boxes share a row when they overlap vertically by this share of the shorter one. */
const ROW_OVERLAP_SHARE = 0.5;
/** Column-width ratios inside this band read as a balanced two-column split rather than a sidebar. */
const BALANCED_RATIO_MIN = 0.35;
const BALANCED_RATIO_MAX = 0.65;
/** Slack, in px, when comparing a child's left and right gaps to call it centered. */
const CENTERING_SLACK_PX = 3;
/** Share of children that must read as centered for the container to count as centered. */
const CENTERED_SHARE = 0.6;
/** How many wrapper levels section discovery descends before it stops looking for sections. */
const MAX_DISCOVERY_DEPTH = 4;
/** How many single-child wrappers discovery skips past before giving up. */
const MAX_DISCOVERY_UNWRAP = 12;
/** A page wrapper's children each span nearly its full width; this is "nearly". */
const FULL_WIDTH_SHARE = 0.9;
/** This share of an element's children must span full width for it to read as a page wrapper. */
const WRAPPER_CHILD_SHARE = 0.75;
/** A page wrapper covers most of the document; a section inside one does not. */
const PAGE_WRAPPER_HEIGHT_SHARE = 0.6;
/** A wrapper's child must fill this share of its box for the wrapper to count as pure packaging. */
const WRAPPER_FILL_SHARE = 0.98;
/** Fewest similar boxes in a run before it reads as repetition rather than as two or three parts. */
const MIN_REPEAT_ITEMS = 3;
/** How far from the median an item's width and height may sit and still belong to the run. */
const ITEM_SIZE_TOLERANCE = 0.35;
/** How many of a run's items are fingerprinted when checking for a duplicated marquee track. */
const MAX_DUPLICATE_PROBES = 60;
/** How deep the text reader descends, and how much of one line it keeps. */
const MAX_TEXT_DEPTH = 6;
const MAX_LINE_CHARS = 120;
/** A nav bar spans this share of the viewport width. */
const NAV_BAR_WIDTH_SHARE = 0.6;
/** A nav bar starts within this many px of the top of the document. */
const NAV_TOP_BAND_PX = 240;
/** Tallest box that still reads as a bar rather than a section wrapping one. */
const NAV_MAX_BAR_HEIGHT_SHARE = 0.25;
const NAV_MIN_BAR_HEIGHT_PX = 200;

/** Tags whose insides are content, not layout: unwrapping into one would lose the structure. */
const CONTENT_TAGS = new Set([
	'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'img', 'picture', 'video', 'svg', 'canvas',
	'button', 'a', 'input', 'textarea', 'select', 'label', 'table', 'form', 'ul', 'ol', 'dl',
]);

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

/** Cache of a container's rendered children; the dom is static for the length of one extraction. */
const childCache = new WeakMap<Element, Element[]>();

/**
 * An element's children that actually paint a box in flow. Out-of-flow children are excluded
 * because a decoration positioned over a section is not one of its columns.
 */
export function contentChildren(el: Element): Element[] {
	const cached = childCache.get(el);
	if (cached) return cached;

	const out: Element[] = [];
	for (let i = 0; i < el.children.length; i++) {
		const child = el.children[i]!;
		if (SKIP_TAGS.has(child.tagName.toLowerCase())) continue;
		if (!isElementVisible(child)) continue;
		const position = window.getComputedStyle(child).position;
		if (position === 'absolute' || position === 'fixed') continue;
		const rect = child.getBoundingClientRect();
		if (rect.width < MIN_BOX_PX || rect.height < MIN_BOX_PX) continue;
		out.push(child);
	}

	childCache.set(el, out);
	return out;
}

/** True when an element carries text of its own, not only text inside its children. */
export function hasDirectText(el: Element): boolean {
	for (let i = 0; i < el.childNodes.length; i++) {
		const node = el.childNodes[i]!;
		if (node.nodeType === 3 && (node.nodeValue || '').trim() !== '') return true;
	}
	return false;
}

/**
 * Skips the chain of single-child wrapper divs a framework build puts between a section and
 * its content, returning the first element that carries content or branches. Stops at a
 * content tag so unwrapping never descends inside a heading or a button.
 */
export function contentRoot(el: Element): Element {
	let current = el;
	for (let i = 0; i < MAX_UNWRAP; i++) {
		if (hasDirectText(current)) break;
		const kids = contentChildren(current);
		if (kids.length !== 1) break;
		const only = kids[0]!;
		if (CONTENT_TAGS.has(only.tagName.toLowerCase())) break;
		if (only.children.length === 0) break;
		// A child wider than its parent is a track being clipped or scrolled, and the parent is
		// the window doing that. Stepping inside the track would make the track the section.
		if (only.getBoundingClientRect().width > current.getBoundingClientRect().width + OVERFLOW_SLACK_PX) break;
		current = only;
	}
	return current;
}

/** Groups boxes into rows: children whose vertical spans overlap sit on the same row. */
function rowsOf(children: Element[]): Element[][] {
	const boxes = children
		.map((el) => ({ el, rect: el.getBoundingClientRect() }))
		.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

	const rows: Array<{ top: number; bottom: number; items: Element[] }> = [];
	for (const { el, rect } of boxes) {
		const row = rows[rows.length - 1];
		if (row) {
			const overlap = Math.min(row.bottom, rect.bottom) - Math.max(row.top, rect.top);
			const shorter = Math.min(row.bottom - row.top, rect.height);
			if (shorter > 0 && overlap / shorter >= ROW_OVERLAP_SHARE) {
				row.items.push(el);
				row.top = Math.min(row.top, rect.top);
				row.bottom = Math.max(row.bottom, rect.bottom);
				continue;
			}
		}
		rows.push({ top: rect.top, bottom: rect.bottom, items: [el] });
	}

	return rows.map((row) => row.items.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left));
}

/** Every descendant container with at least two rendered children, the content root included. */
function scanContainers(root: Element): Element[] {
	const found: Element[] = [];
	let scanned = 0;
	const queue: Array<{ el: Element; depth: number }> = [{ el: root, depth: 0 }];

	while (queue.length > 0 && scanned < MAX_SCAN_NODES) {
		const { el, depth } = queue.shift()!;
		scanned++;
		const kids = contentChildren(el);
		if (kids.length >= 2) found.push(el);
		if (depth >= MAX_SCAN_DEPTH) continue;
		for (const kid of kids) queue.push({ el: kid, depth: depth + 1 });
	}

	return found;
}

/** True when a container's children are visually centered inside it, by declaration or by gaps. */
export function isCentered(container: Element, kids: Element[]): boolean {
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
 * Reads a section's alignment from the container that holds its content, never from the
 * section wrapper, whose text-align says nothing about where the content actually sits.
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
 * Measures a section's layout from its rendered boxes.
 *
 * The content root is always a candidate, so a section that divides at its top level is read
 * there. When it stacks instead, the largest nested container that both divides horizontally
 * and is a substantial part of the section wins, which is how a features grid under a heading
 * is found without a button strip inside a stacked hero being mistaken for one.
 */
export function readLayout(section: Element): LayoutReading {
	const content = contentRoot(section);
	const base = content.getBoundingClientRect();
	const baseArea = base.width * base.height;
	const rootKids = contentChildren(content);

	if (rootKids.length === 0) {
		// A bare run of text is a measured single column. Nothing at all is not: a section whose
		// content paints no box has no layout to report, and saying "single-column" there would
		// be the silent fallback the whole contract depends on not making.
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
			// A container wider than the section is a track being scrolled or animated through
			// a window, not a row of columns. Counted as columns it reported a logo marquee as
			// a fifty-six column grid, which is true of the boxes and useless as a layout.
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
 * Finds the page's sections, descending through the wrappers that hide them.
 *
 * A framework build wraps the whole page in an app root, so the sections are grandchildren of
 * body rather than children, and reading body's children alone finds exactly one "section"
 * that is the entire page. Descent is deliberately narrow: only a transparent single-child
 * wrapper is skipped, and only an element whose children each span its full width and which
 * covers most of the document is opened up. A three-across card grid fails both tests, so
 * cards never get promoted to sections.
 */
export function discoverSections(): Element[] {
	const out: Element[] = [];
	for (let i = 0; i < document.body.children.length; i++) {
		const el = document.body.children[i]!;
		if (SKIP_TAGS.has(el.tagName.toLowerCase())) continue;
		if (!isElementVisible(el)) continue;
		expandSection(el, 0, out);
	}
	return out;
}

/** Adds one candidate to the section list, or its children when it is only a page wrapper. */
function expandSection(el: Element, depth: number, out: Element[]): void {
	const current = unwrapForDiscovery(el);
	if (depth < MAX_DISCOVERY_DEPTH && isPageWrapper(current)) {
		for (const kid of contentChildren(current)) expandSection(kid, depth + 1, out);
		return;
	}
	if (!out.includes(current)) out.push(current);
}

/**
 * Skips single-child wrapper divs, which carry no section of their own.
 *
 * The test is geometric: a wrapper is skipped only when its child fills its box, so a wrapper
 * that pads or insets what it holds is doing layout and stays. What it paints is not part of
 * the test, because the div a framework paints the page background on is still a wrapper, and
 * refusing to descend past it hid an entire page's sections behind one. The backdrop is not
 * lost either way: the section pass resolves what each section actually sits on.
 */
function unwrapForDiscovery(el: Element): Element {
	let current = el;
	for (let i = 0; i < MAX_DISCOVERY_UNWRAP; i++) {
		if (!isGenericWrapper(current) || hasDirectText(current)) break;
		const kids = contentChildren(current);
		if (kids.length !== 1) break;
		const only = kids[0]!;
		if (!fillsParent(only, current)) break;
		current = only;
	}
	return current;
}

/** True for a plain div or span, the tags a build emits when it needs somewhere to hang a class. */
function isGenericWrapper(el: Element): boolean {
	const tag = el.tagName.toLowerCase();
	return tag === 'div' || tag === 'span';
}

/** True when a child occupies its parent's whole box, so the parent adds no layout of its own. */
function fillsParent(child: Element, parent: Element): boolean {
	const inner = child.getBoundingClientRect();
	const outer = parent.getBoundingClientRect();
	if (outer.width <= 0 || outer.height <= 0) return false;
	return inner.width >= outer.width * WRAPPER_FILL_SHARE && inner.height >= outer.height * WRAPPER_FILL_SHARE;
}

/** True when an element is the page's own wrapper rather than one of its sections. */
function isPageWrapper(el: Element): boolean {
	const tag = el.tagName.toLowerCase();
	if (tag !== 'div' && tag !== 'main') return false;

	const kids = contentChildren(el);
	if (kids.length < 2) return false;

	const rect = el.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return false;
	const docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
	if (docHeight > 0 && rect.height < docHeight * PAGE_WRAPPER_HEIGHT_SHARE) return false;

	const fullWidth = kids.filter((kid) => kid.getBoundingClientRect().width >= rect.width * FULL_WIDTH_SHARE).length;
	return fullWidth / kids.length >= WRAPPER_CHILD_SHARE;
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

/**
 * Measures a section's repetition: the run of similar boxes inside the container its layout was
 * read from.
 *
 * This exists because a label alone is useless. "logos, horizontal-scroll" tells an agent
 * nothing it can rebuild, so it invents a layout; fifteen boxes of 120x36 tells it exactly what
 * to draw. Similarity is judged by size against the median, never by class name, so a hashed
 * build reads the same as a hand-written one.
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

	// An item the page holds but this viewport does not render, a carousel's off-slide panels,
	// still belongs to the run: the count is what the dom carries, not what happens to be shown.
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
 * How many distinct items a run holds.
 *
 * A seamless marquee duplicates its whole item run so the loop has no visible seam, so the dom
 * carries every logo twice and a raw count reports twice as many logos as the page shows. When
 * the sequence is an exact repetition of its own first half, the first half is the run. This is
 * a property of the data, read off the items themselves, not a rule about marquees.
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

/** An element's element children, rendered or not, minus the tags the schema never reads. */
function elementChildren(el: Element): Element[] {
	const out: Element[] = [];
	for (let i = 0; i < el.children.length; i++) {
		const child = el.children[i]!;
		if (SKIP_TAGS.has(child.tagName.toLowerCase())) continue;
		out.push(child);
	}
	return out;
}

/** The middle value of a set of measurements. */
function median(values: number[]): number {
	const sorted = values.slice().sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
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

/**
 * The lines of text an element paints, each one the own text of a descendant, in document order.
 *
 * textContent is not usable for this: it concatenates every descendant's text with no separator,
 * so a stat block reads as "1,900+Universities" and the shape of its first line is lost. What a
 * classifier needs is the lines a reader sees, which is exactly one per text-carrying node.
 */
export function textLines(el: Element, max: number): string[] {
	const lines: string[] = [];
	const visit = (node: Element, depth: number): void => {
		if (depth > MAX_TEXT_DEPTH || lines.length >= max) return;
		for (let i = 0; i < node.childNodes.length; i++) {
			if (lines.length >= max) return;
			const child = node.childNodes[i]!;
			if (child.nodeType === 3) {
				const text = (child.nodeValue || '').replace(/\s+/g, ' ').trim();
				if (text) lines.push(text.slice(0, MAX_LINE_CHARS));
			} else if (child.nodeType === 1) {
				const element = child as Element;
				if (SKIP_TAGS.has(element.tagName.toLowerCase())) continue;
				visit(element, depth + 1);
			}
		}
	};
	visit(el, 0);
	return lines;
}

/** True when a box is bar-shaped: short enough to be a page's navigation rather than a section. */
export function isBarShaped(rect: DOMRect): boolean {
	return rect.height <= Math.max(NAV_MIN_BAR_HEIGHT_PX, window.innerHeight * NAV_MAX_BAR_HEIGHT_SHARE);
}

/**
 * Picks the page's nav bar: the widest, topmost, most anchored candidate, then its outermost bar.
 *
 * Geometry decides, not document order. Taking the first `nav` on the page picked up whatever
 * inner list a framework emitted first, a 24px-tall element with no background and no layout,
 * and reported that as the page's navigation. What a reader means by the nav is the bar at the
 * top: wide, near the top of the document, often sticky or fixed.
 *
 * When a page names no landmark at all, which a div-only build does, the same geometry runs
 * over the discovered sections instead. A page with a bar still has a bar; refusing to look for
 * it anywhere but a `header` tag reported `nav: null` for a navigation that was plainly there.
 */
export function findNavBar(roots: Element[]): Element | null {
	const landmarks = Array.from(document.querySelectorAll('header, nav, [role="navigation"]')).filter(isElementVisible);
	const candidates = landmarks.length > 0 ? landmarks : roots.filter(isAnchoredBar);
	if (candidates.length === 0) return null;

	let best: { el: Element; score: number } | null = null;
	for (const el of candidates) {
		const rect = el.getBoundingClientRect();
		const top = rect.top + window.scrollY;
		const computed = window.getComputedStyle(el);
		let score = -Math.min(top, 4000) / 100;
		if (rect.width >= window.innerWidth * NAV_BAR_WIDTH_SHARE) score += 100;
		if (computed.position === 'fixed' || computed.position === 'sticky') score += 60;
		if (top <= NAV_TOP_BAND_PX) score += 40;
		if (el.querySelectorAll('a').length >= 2) score += 20;
		if (el.tagName.toLowerCase() === 'header') score += 10;
		if (!best || score > best.score) best = { el, score };
	}
	if (!best) return null;

	// Climb to the bar that contains the pick. An inner nav describes one part of a header;
	// the header is the bar a redesign has to reproduce. Only climb while it is still a bar.
	let chosen = best.el;
	for (const el of candidates) {
		if (el === chosen || !el.contains(chosen)) continue;
		const rect = el.getBoundingClientRect();
		if (!isBarShaped(rect)) continue;
		if (rect.width < chosen.getBoundingClientRect().width) continue;
		chosen = el;
	}
	return chosen;
}

/** The fallback candidate: a fixed or sticky bar across the top, which is a nav whatever its tag. */
function isAnchoredBar(el: Element): boolean {
	const position = window.getComputedStyle(el).position;
	if (position !== 'fixed' && position !== 'sticky') return false;
	const rect = el.getBoundingClientRect();
	if (rect.width < window.innerWidth * NAV_BAR_WIDTH_SHARE) return false;
	if (rect.top + window.scrollY > NAV_TOP_BAND_PX) return false;
	return isBarShaped(rect) && el.querySelectorAll('a').length >= 1;
}
