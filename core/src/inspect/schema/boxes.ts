/**
 * inspect/schema/boxes.ts: the rendered-box primitives every geometric read is built on.
 *
 * Runs during the page-scoped inspect pass, against the live dom. Nothing here decides what
 * a section or a layout is; it answers the smaller questions those decisions rest on: which
 * children actually paint a box, where a wrapper chain ends, which boxes share a row, and
 * what text an element paints.
 */
import { isElementVisible, SKIP_TAGS } from './classify';

/** Smallest box, in px, that counts as rendered content rather than a hairline or a spacer. */
export const MIN_BOX_PX = 4;
/** Slack, in px, before a child painting past its container's edge counts as overflow. */
export const OVERFLOW_SLACK_PX = 8;
/** How much of one line of text the reader keeps. */
export const MAX_LINE_CHARS = 120;

/** How many single-child wrappers to skip before giving up. Framework chains are long but finite. */
const MAX_UNWRAP = 12;
/** Bounds on the container scan, so a section with thousands of nodes cannot stall the pass. */
const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_NODES = 300;
/** Two boxes share a row when they overlap vertically by this share of the shorter one. */
const ROW_OVERLAP_SHARE = 0.5;
/** How deep the text reader descends. */
const MAX_TEXT_DEPTH = 6;

/** Tags whose insides are content, not layout: unwrapping into one would lose the structure. */
const CONTENT_TAGS = new Set([
	'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'img', 'picture', 'video', 'svg', 'canvas',
	'button', 'a', 'input', 'textarea', 'select', 'label', 'table', 'form', 'ul', 'ol', 'dl',
]);

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

/** An element's element children, rendered or not, minus the tags the schema never reads. */
export function elementChildren(el: Element): Element[] {
	const out: Element[] = [];
	for (let i = 0; i < el.children.length; i++) {
		const child = el.children[i]!;
		if (SKIP_TAGS.has(child.tagName.toLowerCase())) continue;
		out.push(child);
	}
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
export function rowsOf(children: Element[]): Element[][] {
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
export function scanContainers(root: Element): Element[] {
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

/** The middle value of a set of measurements. */
export function median(values: number[]): number {
	const sorted = values.slice().sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
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
