/**
 * inspect/schema/page-language.ts: the page's decorative and responsive language.
 *
 * Runs during the page-scoped inspect pass, against the live dom. This is the part a token
 * list always misses: the gradients, blobs, illustration mix, accent treatments, and what the
 * page's media queries say about its breakpoints and its mobile navigation.
 *
 * Every background effect names the section it was seen in. Stated page-wide it was true and
 * useless: an agent read `effects gradient` as permission and painted gradients into a hero
 * whose measured background is flat. An effect no section holds carries no location, and the
 * renderer drops it rather than offering the reader a fact it cannot place.
 */
import { isElementVisible } from './classify';
import { sectionFinder } from './discovery';
import type { BackgroundEffect, DecorativeInfo, ResponsiveInfo } from './types';

/** Ceiling on the decorative reading, so a feed of thousands of nodes cannot stall the pass. */
const MAX_DECORATIVE_ELEMENTS = 5000;
/** Blur past this radius, in px, is a decorative blob rather than a soft edge on a real box. */
const BLOB_BLUR_PX = 20;
/** A round box wider than this is a blob; anything smaller is a chip or an avatar. */
const MIN_BLOB_WIDTH = 80;
/** How many images and svgs the media mix reads. */
const MAX_MEDIA_SAMPLES = 30;
/** An svg smaller than this in both axes is an icon inside something, not the page's artwork. */
const MIN_ILLUSTRATION_SVG_PX = 40;
/** Share of the media one kind must hold, and how many of it, before it names the page's mix. */
const MEDIA_MAJORITY = 0.6;
const MIN_MEDIA_ITEMS = 3;
/** Raster image formats, which is what separates a photo-led page from a drawn one. */
const RASTER_EXTENSION = /\.(?:jpe?g|png|webp|avif)/;
/** Controls the accent reading probes, and the badge shapes it counts. */
const ACCENT_PROBE_SELECTOR = 'button, [class*="btn"]';
const BADGE_SELECTOR = '[class*="badge"], [class*="pill"], [class*="chip"], [class*="tag"]';
const MAX_ACCENT_PROBES = 10;
/** Fewest badge-shaped elements before pill badges read as the page's accent language. */
const MIN_PILL_BADGES = 2;
/** How many of the nav's links are probed against the sheets, and how far up from each one. */
const MAX_NAV_LINK_PROBES = 12;
const MAX_NAV_LINK_CLIMB = 4;
/** How many breakpoints the schema reports. */
const MAX_BREAKPOINTS = 5;

/**
 * Detects the page's decorative language: blobs, located background effects, illustration mix,
 * and accent treatments.
 *
 * The illustration mix stays page-wide on purpose. It describes what kind of media the page
 * uses, which has no single location, and nothing in it licenses painting anything.
 */
export function extractDecorativeInfo(sectionRoots: Element[]): DecorativeInfo {
	const findSection = sectionFinder(sectionRoots);
	const indexOfSection = new Map<Element, number>(sectionRoots.map((el, index) => [el, index]));
	const effects = new Map<string, BackgroundEffect>();
	const accentTreatments = new Set<string>();
	let hasBlobs = false;

	// One entry per effect per section: a page with gradients in three sections reports three,
	// and a section painting two gradients reports one.
	const record = (effect: string, el: Element): void => {
		const root = findSection(el);
		const section = root ? indexOfSection.get(root) : undefined;
		const key = `${effect}|${section ?? ''}`;
		if (!effects.has(key)) effects.set(key, section === undefined ? { effect } : { effect, section });
	};

	// Every element, not a spread sample of them. A strided sample lands on different elements
	// as soon as the page's element count moves by one, so two reads of one page reported the
	// gradient in different sections. A contract that answers differently each time it is read
	// is not a measurement.
	const allElements = document.querySelectorAll('*');
	const examined = Math.min(allElements.length, MAX_DECORATIVE_ELEMENTS);
	for (let i = 0; i < examined; i++) {
		const el = allElements[i]!;
		// An element that paints no box carries no design fact. A live page declared a gradient
		// on a 0x0 node and the schema reported a gradient in that node's section, which is an
		// effect the reader can see nowhere on the page.
		if (!isElementVisible(el)) continue;
		const computed = window.getComputedStyle(el);

		if (computed.backgroundImage && computed.backgroundImage.includes('gradient')) record('gradient', el);
		if (computed.backdropFilter && computed.backdropFilter !== 'none') record('backdrop-blur', el);
		if (computed.filter && computed.filter.includes('blur') && parseFloat(computed.filter.replace(/[^0-9.]/g, '')) > BLOB_BLUR_PX) {
			hasBlobs = true;
			record('blur-blobs', el);
		}
		const round = computed.borderRadius === '50%' || computed.borderRadius === '9999px';
		if (round && el.getBoundingClientRect().width > MIN_BLOB_WIDTH) hasBlobs = true;
	}

	for (const btn of Array.from(document.querySelectorAll(ACCENT_PROBE_SELECTOR)).slice(0, MAX_ACCENT_PROBES)) {
		const computed = window.getComputedStyle(btn);
		if (computed.boxShadow.includes('0px 4px 0') || computed.boxShadow.includes('0 4px 0')) accentTreatments.add('hard-shadow-buttons');
		if (computed.backgroundImage?.includes('gradient')) accentTreatments.add('gradient-buttons');
	}
	if (document.querySelectorAll(BADGE_SELECTOR).length >= MIN_PILL_BADGES) accentTreatments.add('pill-badges');

	return {
		hasBlobs,
		illustrationStyle: readIllustrationStyle(),
		backgroundEffects: Array.from(effects.values()),
		accentTreatments: Array.from(accentTreatments),
	};
}

/** Names the page's media mix from the share of it that is drawn rather than photographed. */
function readIllustrationStyle(): string {
	let svgImgCount = 0;
	let rasterCount = 0;
	for (const img of Array.from(document.querySelectorAll('img')).slice(0, MAX_MEDIA_SAMPLES)) {
		const src = (img.getAttribute('src') || '').toLowerCase();
		if (src.includes('.svg') || src.startsWith('data:image/svg')) svgImgCount++;
		else if (RASTER_EXTENSION.test(src)) rasterCount++;
	}
	let significantSvgCount = 0;
	for (const svg of Array.from(document.querySelectorAll('svg')).slice(0, MAX_MEDIA_SAMPLES)) {
		const rect = svg.getBoundingClientRect();
		if (rect.width > MIN_ILLUSTRATION_SVG_PX && rect.height > MIN_ILLUSTRATION_SVG_PX) significantSvgCount++;
	}

	const totalSvgs = svgImgCount + significantSvgCount;
	const totalMedia = totalSvgs + rasterCount;
	if (totalMedia === 0) return 'none';
	// Both shares are rounded to the same two places the ratios were reported in, so the two
	// thresholds compare against one number rather than each against its own precision.
	const svgShare = Math.round((totalSvgs / totalMedia) * 100) / 100;
	const photoShare = Math.round((rasterCount / totalMedia) * 100) / 100;
	if (svgShare > MEDIA_MAJORITY && totalSvgs >= MIN_MEDIA_ITEMS) return 'icon-based';
	if (photoShare > MEDIA_MAJORITY && rasterCount >= MIN_MEDIA_ITEMS) return 'photo';
	return totalMedia >= MIN_MEDIA_ITEMS ? 'mixed' : 'none';
}

/**
 * Reads the page's responsive behavior from its media queries.
 *
 * Both behaviors report `unknown` when no rule provides evidence, exactly as an unmeasurable
 * layout does. They used to default to `unchanged` and `stack`, so a page that hides its nav
 * links behind a hamburger was described, confidently and wrongly, as one whose navigation does
 * not change. A silent fallback under a hard contract costs more than an honest gap.
 */
export function extractResponsiveInfo(rules: CSSRule[], navBar: Element | null): ResponsiveInfo {
	const breakpoints = new Set<string>();
	let gridCollapseBehavior = 'unknown';

	for (const rule of rules) {
		if (!(rule instanceof CSSMediaRule)) continue;
		const width = breakpointOf(rule.conditionText || rule.media?.mediaText || '');
		if (width) breakpoints.add(width);

		const ruleText = Array.from(rule.cssRules || []).map((r) => (r instanceof CSSStyleRule ? r.cssText : '')).join(' ');
		if (/grid-template-columns:\s*1fr\b/.test(ruleText)) gridCollapseBehavior = 'stack';
		else if (/overflow-x:\s*(?:auto|scroll)/.test(ruleText)) gridCollapseBehavior = 'scroll';
		else if (/grid-template-columns:\s*repeat\(2/.test(ruleText)) gridCollapseBehavior = 'reduce-columns';
	}

	return {
		breakpoints: Array.from(breakpoints).sort((a, b) => toPx(a) - toPx(b)).slice(0, MAX_BREAKPOINTS),
		mobileNavStyle: navHiddenOnMobile(rules, navBar) ? 'hamburger' : 'unknown',
		gridCollapseBehavior,
	};
}

/**
 * True when the page's own nav links are hidden at mobile widths, which means a hamburger.
 *
 * The test is per element, not per selector text. A utility build never emits a rule that
 * mentions "nav", so matching rule text for `nav ... display: none` found nothing on the builds
 * that most need reading; it matched only pages that happened to name their selectors the way
 * the regex expected. Asking each real link element whether a rule matches it works whatever the
 * selector is called, and `el.matches` handles the escaped utility selectors natively.
 *
 * Two shapes count. A link hidden under a max-width condition is the plain case. A link shown
 * only above a min-width is the utility case, `class="hidden md:flex"`, and it counts only when
 * some unconditioned rule really does hide that same element, so a media query that merely
 * switches a visible display for another one is not read as a hamburger.
 */
function navHiddenOnMobile(rules: CSSRule[], navBar: Element | null): boolean {
	if (!navBar) return false;
	const links = navLinkNodes(navBar);
	if (links.length === 0) return false;

	const hiddenByBase = (el: Element): boolean =>
		rules.some((rule) => rule instanceof CSSStyleRule && rule.style.getPropertyValue('display').trim() === 'none' && matchesSafely(el, rule.selectorText));

	for (const rule of rules) {
		if (!(rule instanceof CSSMediaRule)) continue;
		const bound = widthBound(rule.conditionText || rule.media?.mediaText || '');
		if (!bound) continue;

		for (const inner of Array.from(rule.cssRules || [])) {
			if (!(inner instanceof CSSStyleRule)) continue;
			const display = inner.style.getPropertyValue('display').trim();
			if (bound === 'max' && display !== 'none') continue;
			if (bound === 'min' && (display === '' || display === 'none')) continue;
			for (const link of links) {
				if (!matchesSafely(link, inner.selectorText)) continue;
				if (bound === 'max' || hiddenByBase(link)) return true;
			}
		}
	}
	return false;
}

/** The nav's links and the boxes that hold them, which is what a build hides at mobile widths. */
function navLinkNodes(bar: Element): Element[] {
	const out = new Set<Element>();
	for (const link of Array.from(bar.querySelectorAll('a')).slice(0, MAX_NAV_LINK_PROBES)) {
		let current: Element | null = link;
		for (let i = 0; i < MAX_NAV_LINK_CLIMB && current && current !== bar; i++) {
			out.add(current);
			current = current.parentElement;
		}
	}
	return Array.from(out);
}

/** Whether a media condition turns on below a width or above one. Both notations are read. */
function widthBound(media: string): 'min' | 'max' | null {
	if (/max-width:/.test(media)) return 'max';
	if (/min-width:/.test(media)) return 'min';
	if (/width\s*>=?\s*\d/.test(media)) return 'min';
	if (/width\s*<=?\s*\d/.test(media)) return 'max';
	if (/\d\s*<=?\s*width/.test(media)) return 'min';
	if (/\d\s*>=?\s*width/.test(media)) return 'max';
	return null;
}

/** Element.matches over a selector a sheet may have authored in a syntax this engine rejects. */
function matchesSafely(el: Element | null, selector: string): boolean {
	if (!el || !selector) return false;
	try {
		return el.matches(selector);
	} catch {
		return false; // A selector this engine cannot parse matches nothing.
	}
}

/**
 * The width a media condition turns on at, in whichever notation it was authored.
 *
 * Both notations have to be read. Every current utility framework emits the range form,
 * `(width >= 40rem)`, and matching only `min-width:` reported that such a page declares no
 * breakpoints at all.
 */
function breakpointOf(media: string): string | null {
	const LENGTH = '(\\d+(?:\\.\\d+)?(?:px|em|rem))';
	const legacy = media.match(new RegExp(`(?:max|min)-width:\\s*${LENGTH}`));
	if (legacy) return legacy[1]!;
	const range = media.match(new RegExp(`width\\s*[<>]=?\\s*${LENGTH}`)) ?? media.match(new RegExp(`${LENGTH}\\s*[<>]=?\\s*width`));
	return range ? range[1]! : null;
}

/** A css length in px, so breakpoints authored in rem and px still sort against each other. */
function toPx(value: string): number {
	const n = parseFloat(value);
	if (isNaN(n)) return 0;
	return /r?em$/.test(value) ? n * 16 : n;
}
