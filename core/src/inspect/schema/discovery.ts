/**
 * inspect/schema/discovery.ts: finding the page's sections and its nav bar.
 *
 * Runs first in the page-scoped inspect pass, against the live dom. What a section is gets
 * decided once, here, so everything downstream agrees. The walk spends its budget per section.
 * The section pass describes them, the nav is scored among them, and the decorative pass says
 * which one each effect sits in.
 *
 * Both readings are geometric. A framework build wraps the whole page in an app root, so
 * body's children alone give one "section" that is the entire page. And the first `nav` tag is
 * whatever inner list the build emitted first, not the bar a reader means.
 */
import { isElementVisible, SKIP_TAGS } from './classify';
import { contentChildren, hasDirectText } from './boxes';

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
/** A nav bar spans this share of the viewport width. */
const NAV_BAR_WIDTH_SHARE = 0.6;
/** A nav bar starts within this many px of the top of the document. */
const NAV_TOP_BAND_PX = 240;
/** Tallest box that still reads as a bar rather than a section wrapping one. */
const NAV_MAX_BAR_HEIGHT_SHARE = 0.25;
const NAV_MIN_BAR_HEIGHT_PX = 200;

/**
 * Finds the page's sections, descending through the wrappers that hide them, since a framework
 * build makes them grandchildren of body rather than children.
 *
 * Descent is deliberately narrow. Only a transparent single-child wrapper is skipped, and only
 * an element whose children each span its full width and which covers most of the document is
 * opened up. A three-across card grid fails both, so cards are never promoted to sections.
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
 * Skips single-child wrapper divs, which carry no section of their own. Geometric: a wrapper is
 * skipped only when its child fills its box, so one that pads or insets is doing layout and
 * stays. What it paints is not part of the test. The div a framework paints the page background
 * on is still a wrapper, and refusing to descend past it hid a whole page's sections. The
 * section pass resolves what each section sits on either way.
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

/**
 * The lookup from any element to the section containing it, or null. The walk needs it to spend
 * each section's budget and the decorative pass to say where an effect was seen. Two climbs
 * with two stopping rules could attribute one element to two sections, so there is one climb.
 */
export function sectionFinder(roots: Element[]): (el: Element) => Element | null {
	const known = new Set(roots);
	return (el: Element): Element | null => {
		let current: Element | null = el;
		while (current && !known.has(current)) current = current.parentElement;
		return current;
	};
}

/** True when a box is bar-shaped: short enough to be a page's navigation rather than a section. */
export function isBarShaped(rect: DOMRect): boolean {
	return rect.height <= Math.max(NAV_MIN_BAR_HEIGHT_PX, window.innerHeight * NAV_MAX_BAR_HEIGHT_SHARE);
}

/**
 * Picks the page's nav bar: the widest, topmost, most anchored candidate, then its outermost
 * bar. Geometry decides, not document order, because the first `nav` on the page is often an
 * inner list a framework emitted, 24px tall with no background. What a reader means is the bar
 * at the top: wide, near the top of the document, often sticky.
 *
 * With no landmark at all, which a div-only build gives, the same geometry runs over the
 * discovered sections. A page with a bar still has a bar, and looking only for a `header` tag
 * reported `nav: null` for a navigation that was plainly there.
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

	// Climb to the bar containing the pick, while it is still bar-shaped. An inner nav is one
	// part of a header, and the header is what a redesign has to reproduce.
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
