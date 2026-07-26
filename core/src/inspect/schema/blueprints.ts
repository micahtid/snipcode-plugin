/**
 * inspect/schema/blueprints.ts: the button, card, and nav specs plus the page's visual language
 *
 * Pipeline position: inspect, page-scoped. See inspect/schema/extract.ts for the whole pass.
 * Reads from DOM: document/window, including geometry. This runs live.
 * Writes to: nothing.
 *
 * Why this exists: tokens say what values a page uses, but not how it assembles them into the
 * components a redesign has to match. These passes read the components back out as full
 * specs, a button with its fill, radius, padding, border, shadow, and its hover and active
 * changes, a card with its inner layout, the nav with its position and blur. The decorative
 * and responsive passes cover the rest of the page's visual language, the gradients, blobs,
 * illustration mix, and breakpoint behavior, which is the part a token list always misses.
 *
 * A blueprint is what an agent actually reads, so every value in one crosses the same gate the
 * token list does. They are two paths to the same reader, and a radius that printed as
 * 3.35544e+07px in a button spec beside a clean 9999px in the token list is the schema
 * disagreeing with itself.
 */
import { classNameOf, isElementVisible } from './classify';
import { contentChildren, contentRoot } from './geometry';
import { hexToRgb, oklabDistance, rgbToOklab } from './oklab';
import { effectiveBackground, groupBy, isTransparentColor, normalizeColor, paddingShorthand, paintedShadow, radiusShorthand, type WalkedElement } from './shared';
import type { ButtonBlueprint, CardBlueprint, DecorativeInfo, NavBlueprint, ResponsiveInfo, StateRule } from './types';

/** How many of a card's blocks the inner-layout string names. */
const MAX_CARD_PARTS = 6;
/** Smallest box, in px, that reads as a clickable control rather than a stray styled node. */
const MIN_BUTTON_WIDTH = 40;
const MIN_BUTTON_HEIGHT = 20;
/** Largest box that is still a control rather than a linked card or banner. */
const MAX_BUTTON_HEIGHT = 120;
const MAX_BUTTON_WIDTH_SHARE = 0.5;
/** How many button variants one page reports. */
const MAX_BUTTON_VARIANTS = 4;
/** Floor on the contrast term, so a large low-contrast button still ranks on its size. */
const CONTRAST_FLOOR = 0.25;
/** How many of the nav's links are probed against the sheets, and how far up from each one. */
const MAX_NAV_LINK_PROBES = 12;
const MAX_NAV_LINK_CLIMB = 4;

/**
 * Extracts the top button variants with their full visual spec and hover/active states.
 *
 * The candidate pool is every button and every anchor, and the gate decides which of them is
 * a button. Matching on class names instead, looking for "btn" or "cta", finds nothing on a
 * page whose classes are utility soup or hashed, which is most framework builds; what a button
 * looks like is the only thing that reads the same everywhere. A candidate must be rendered,
 * padded, big enough to hit but small enough not to be a card, and carrying a label or an icon.
 *
 * Ranking the survivors is by prominence, the area a button occupies weighted by how far its
 * fill sits from what is behind it, rather than by how many times its fingerprint recurred.
 * Frequency alone picked out whatever tiny unstyled node a framework repeated most, and
 * reported a zero-padding grey box as the page's primary button.
 */
export function extractButtonBlueprints(walked: WalkedElement[], states: StateRule[]): ButtonBlueprint[] {
	const buttons = walked.filter((el) => el.role === 'button' || el.tag === 'a' || el.tag === 'button');
	if (buttons.length === 0) return [];

	const groups = groupBy(buttons, (btn) => btn.fingerprint);
	const ranked: Array<{ rep: WalkedElement; score: number }> = [];
	for (const group of groups.values()) {
		const rep = group.find((btn) => isPlausibleButton(btn.element));
		if (!rep) continue;
		ranked.push({ rep, score: prominence(rep.element) });
	}
	if (ranked.length === 0) return [];
	const sorted = ranked.sort((a, b) => b.score - a.score).slice(0, MAX_BUTTON_VARIANTS);

	const pageBg = normalizeColor(window.getComputedStyle(document.body).backgroundColor) || '#ffffff';
	const blueprints: ButtonBlueprint[] = [];

	for (let i = 0; i < sorted.length; i++) {
		const rep = sorted[i]!.rep;
		const computed = window.getComputedStyle(rep.element);
		const bg = normalizeColor(computed.backgroundColor) || 'transparent';
		const color = normalizeColor(computed.color) || '#000000';
		const painted = paintedShadow(computed.boxShadow);
		const shadow = painted !== 'none' ? painted : '';
		const border = computed.borderWidth !== '0px' && computed.borderStyle !== 'none' ? `${computed.borderWidth} ${computed.borderStyle} ${computed.borderColor}` : 'none';

		const btnClasses = Array.from(rep.element.classList);
		const hover: Record<string, string> = {};
		const active: Record<string, string> = {};
		for (const state of states) {
			if (!btnClasses.some((cls) => state.selector.includes(`.${cls}`))) continue;
			if (state.state === 'hover') Object.assign(hover, state.changes);
			if (state.state === 'active') Object.assign(active, state.changes);
		}

		let styleTag = 'flat';
		if (shadow.includes('0px 4px 0') || shadow.includes('0 4px 0') || shadow.includes('0px 3px 0')) {
			styleTag = 'pressed-3d';
		} else if (computed.backgroundImage && computed.backgroundImage !== 'none' && computed.backgroundImage.includes('gradient')) {
			styleTag = 'gradient';
		} else if (isTransparentColor(bg)) {
			styleTag = border !== 'none' ? 'outline' : 'ghost';
		} else if (shadow && shadow !== 'none') {
			styleTag = 'elevated';
		}

		const isTransparent = isTransparentColor(bg);
		const isWhiteOrLight = bg === '#ffffff' || bg === '#fff' || bg === pageBg;
		let variant: string;
		if (isTransparent && border === 'none') variant = 'ghost';
		else if (isTransparent) variant = 'outline';
		else if (i === 0) variant = 'primary';
		else if (isWhiteOrLight) variant = 'secondary';
		else variant = 'accent';

		blueprints.push({
			variant,
			bg,
			color,
			borderRadius: radiusShorthand(computed.borderRadius),
			padding: paddingShorthand(computed),
			fontWeight: parseInt(computed.fontWeight) || 400,
			fontSize: computed.fontSize,
			border,
			shadow,
			hover,
			active,
			styleTag,
		});
	}

	// Propagate the dominant non-flat style language to filled variants whose shadow
	// the extraction missed. A capture gap reads as flat, not as intentional flatness.
	const tagCounts = new Map<string, number>();
	for (const bp of blueprints) tagCounts.set(bp.styleTag, (tagCounts.get(bp.styleTag) || 0) + 1);
	const dominantTag = Array.from(tagCounts.entries()).filter(([tag]) => tag !== 'flat').sort((a, b) => b[1] - a[1])[0];
	if (dominantTag && dominantTag[1] >= 2) {
		for (const bp of blueprints) {
			const isFilled = !isTransparentColor(bp.bg);
			if (isFilled && bp.styleTag === 'flat' && (!bp.shadow || bp.shadow === 'none')) bp.styleTag = dominantTag[0];
		}
	}

	// Two fingerprints can describe the same button, for example the same control rendered at
	// two widths. Reporting it twice under two variant names invents a distinction the page
	// does not make, so identical specs collapse to the more prominent one.
	const distinct: ButtonBlueprint[] = [];
	const specs = new Set<string>();
	for (const bp of blueprints) {
		const spec = [bp.bg, bp.color, bp.borderRadius, bp.padding, bp.fontWeight, bp.fontSize, bp.border, bp.shadow].join('|');
		if (specs.has(spec)) continue;
		specs.add(spec);
		distinct.push(bp);
	}

	// Disambiguate any variant names that collided.
	const seen = new Set<string>();
	for (const bp of distinct) {
		if (seen.has(bp.variant)) bp.variant = `${bp.variant}-${seen.size}`;
		seen.add(bp.variant);
	}

	return distinct;
}

/** A candidate a person could actually click: rendered, hit-sized, padded, and labelled. */
function isPlausibleButton(el: Element): boolean {
	if (!isElementVisible(el)) return false;

	const rect = el.getBoundingClientRect();
	if (rect.width < MIN_BUTTON_WIDTH || rect.height < MIN_BUTTON_HEIGHT) return false;
	// An anchor wrapping a whole card is not a button, however padded it is.
	if (rect.height > MAX_BUTTON_HEIGHT || rect.width > window.innerWidth * MAX_BUTTON_WIDTH_SHARE) return false;

	const computed = window.getComputedStyle(el);
	const padding = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']
		.reduce((sum, side) => sum + (parseFloat(computed[side as 'paddingTop']) || 0), 0);
	if (padding <= 0) return false;

	const labelled = (el.textContent || '').trim().length > 0 || el.querySelector('svg, img') !== null;
	return labelled;
}

/** How much of the page a button claims: its area, weighted by how far its fill stands out. */
function prominence(el: Element): number {
	const rect = el.getBoundingClientRect();
	const own = hexToRgb(effectiveBackground(el));
	const behind = hexToRgb(effectiveBackground(el.parentElement));
	const contrast = own && behind
		? oklabDistance(rgbToOklab(own.r, own.g, own.b), rgbToOklab(behind.r, behind.g, behind.b))
		: 0;
	return rect.width * rect.height * (CONTRAST_FLOOR + contrast);
}

/** Extracts the top card variants with their visual spec, hover state, and inner layout. */
export function extractCardBlueprints(walked: WalkedElement[], states: StateRule[]): CardBlueprint[] {
	const cards = walked.filter((el) => el.role === 'card');
	if (cards.length === 0) return [];

	const groups = groupBy(cards, (card) => card.fingerprint);
	const sorted = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length).slice(0, 3);

	const blueprints: CardBlueprint[] = [];
	for (const [, group] of sorted) {
		const rep = group[0]!;
		const computed = window.getComputedStyle(rep.element);
		const cardClasses = Array.from(rep.element.classList);
		const hover: Record<string, string> = {};
		for (const state of states) {
			if (state.state === 'hover' && cardClasses.some((cls) => state.selector.includes(`.${cls}`))) Object.assign(hover, state.changes);
		}

		blueprints.push({
			bg: normalizeColor(computed.backgroundColor) || '#ffffff',
			borderRadius: radiusShorthand(computed.borderRadius),
			shadow: paintedShadow(computed.boxShadow),
			border: computed.borderWidth !== '0px' && computed.borderStyle !== 'none' ? `${computed.borderWidth} ${computed.borderStyle} ${computed.borderColor}` : 'none',
			padding: paddingShorthand(computed),
			hover,
			innerLayout: detectCardInnerLayout(rep.element),
		});
	}

	return blueprints;
}

/**
 * Describes a card's inner layout as an ordered "image + heading + text" string.
 *
 * Both the card and each of its children are unwrapped first. Reading direct children alone
 * made every framework card report "body + body", since its real content sits one or more
 * hashed divs below whatever the class-name match landed on.
 */
function detectCardInnerLayout(el: Element): string {
	const parts: string[] = [];
	const root = contentRoot(el);
	for (let i = 0; i < Math.min(root.children.length, MAX_CARD_PARTS); i++) {
		const child = contentRoot(root.children[i]!);
		const tag = child.tagName.toLowerCase();
		const classList = classNameOf(child);
		if (tag === 'img' || tag === 'picture' || tag === 'video' || /image|thumbnail|cover/.test(classList)) parts.push('image');
		else if (/^h[1-6]$/.test(tag)) parts.push('heading');
		else if (tag === 'p') parts.push('text');
		else if (tag === 'svg' || /icon/.test(classList)) parts.push('icon');
		else if (tag === 'button' || /btn|button/.test(classList)) parts.push('button');
		else if (child.children.length > 0) parts.push(namedByContent(child));
	}
	return parts.length > 0 ? parts.join(' + ') : 'unknown';
}

/** Names a card sub-block by the first content it holds, so a group reads better than "body". */
function namedByContent(el: Element): string {
	if (el.querySelector('h1, h2, h3, h4, h5, h6')) return 'heading';
	if (el.querySelector('img, picture, video')) return 'image';
	if (el.querySelector('svg')) return 'icon';
	if (el.querySelector('button, a[class*="btn"], a[class*="button"]')) return 'button';
	if (el.querySelector('p')) return 'text';
	return 'body';
}

/**
 * Extracts the page navigation's spec: bg, position, blur, border, layout, and link count.
 *
 * The bar itself is chosen in geometry.ts, by geometry rather than by document order, since
 * what a reader means by the nav is the bar at the top and not whichever `nav` element a
 * framework emitted first.
 */
export function extractNavBlueprint(bar: Element | null): NavBlueprint | null {
	if (!bar) return null;

	const computed = window.getComputedStyle(bar);
	const links = bar.querySelectorAll('a');
	const border = computed.borderBottomWidth !== '0px' && computed.borderBottomStyle !== 'none' ? `${computed.borderBottomWidth} ${computed.borderBottomStyle} ${computed.borderBottomColor}` : 'none';

	let layout = 'unknown';
	// Read the row that actually holds the bar's parts, not the bar element, whose only child
	// on a framework page is another wrapper.
	const row = contentRoot(bar);
	if (contentChildren(row).length >= 2) {
		const hasLogo = bar.querySelector('[class*="logo"], a:first-child img, a:first-child svg');
		const hasCta = bar.querySelector('[class*="cta"], [class*="btn"], button');
		const hasLinks = links.length >= 3;
		if (hasLogo && hasLinks && hasCta) layout = 'logo-left + links-center + cta-right';
		else if (hasLogo && hasLinks) layout = 'logo-left + links-right';
		else if (hasLogo && hasCta) layout = 'logo-left + cta-right';
		else if (hasLogo) layout = 'logo-left';
	}

	return {
		tag: bar.tagName.toLowerCase(),
		bg: normalizeColor(computed.backgroundColor) || 'transparent',
		position: computed.position,
		height: computed.height,
		blur: hasBackdropBlur(computed),
		border,
		layout,
		linkCount: links.length,
	};
}

/**
 * True when a backdrop filter is actually declared. The prefixed property is absent from the
 * computed style in most engines, and testing an absent property against 'none' is true, which
 * reported every nav on every page as blurred.
 */
function hasBackdropBlur(computed: CSSStyleDeclaration): boolean {
	const prefixed = (computed as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter;
	return [computed.backdropFilter, prefixed].some((value) => typeof value === 'string' && value !== '' && value !== 'none');
}

/** Detects the page's decorative language: blobs, gradients, illustration style, accents. */
export function extractDecorativeInfo(): DecorativeInfo {
	let hasBlobs = false;
	let hasGradientBgs = false;
	let hasPatterns = false;
	const backgroundEffects = new Set<string>();
	const accentTreatments = new Set<string>();

	const allElements = document.querySelectorAll('*');
	const sampleSize = Math.min(allElements.length, 200);
	for (let i = 0; i < sampleSize; i++) {
		const el = allElements[Math.floor((i * allElements.length) / sampleSize)]!;
		const computed = window.getComputedStyle(el);

		if (computed.backgroundImage && computed.backgroundImage.includes('gradient')) {
			hasGradientBgs = true;
			backgroundEffects.add('gradient');
		}
		if (computed.backdropFilter && computed.backdropFilter !== 'none') backgroundEffects.add('backdrop-blur');
		if (computed.filter && computed.filter.includes('blur') && parseFloat(computed.filter.replace(/[^0-9.]/g, '')) > 20) {
			hasBlobs = true;
			backgroundEffects.add('blur-blobs');
		}
		if (computed.borderRadius === '50%' || computed.borderRadius === '9999px') {
			if (el.getBoundingClientRect().width > 80) hasBlobs = true;
		}
		if (computed.backgroundImage && (computed.backgroundImage.includes('repeating') || computed.backgroundImage.includes('url('))) hasPatterns = true;
	}

	let svgImgCount = 0;
	let rasterCount = 0;
	for (const img of Array.from(document.querySelectorAll('img')).slice(0, 30)) {
		const src = (img.getAttribute('src') || '').toLowerCase();
		if (src.includes('.svg') || src.startsWith('data:image/svg')) svgImgCount++;
		else if (src.includes('.jpg') || src.includes('.jpeg') || src.includes('.png') || src.includes('.webp') || src.includes('.avif')) rasterCount++;
	}
	let significantSvgCount = 0;
	for (const svg of Array.from(document.querySelectorAll('svg')).slice(0, 30)) {
		const rect = svg.getBoundingClientRect();
		if (rect.width > 40 && rect.height > 40) significantSvgCount++;
	}

	const totalSvgs = svgImgCount + significantSvgCount;
	const totalMedia = totalSvgs + rasterCount;
	const svgRatio = totalMedia > 0 ? Math.round((totalSvgs / totalMedia) * 100) / 100 : 0;
	const photoRatio = totalMedia > 0 ? Math.round((rasterCount / totalMedia) * 100) / 100 : 0;

	let illustrationStyle = 'none';
	if (totalMedia === 0) illustrationStyle = 'none';
	else if (svgRatio > 0.6 && totalSvgs >= 3) illustrationStyle = 'icon-based';
	else if (photoRatio > 0.6 && rasterCount >= 3) illustrationStyle = 'photo';
	else if (totalMedia >= 3) illustrationStyle = 'mixed';

	for (const btn of Array.from(document.querySelectorAll('button, [class*="btn"]')).slice(0, 10)) {
		const computed = window.getComputedStyle(btn);
		if (computed.boxShadow.includes('0px 4px 0') || computed.boxShadow.includes('0 4px 0')) accentTreatments.add('hard-shadow-buttons');
		if (computed.backgroundImage?.includes('gradient')) accentTreatments.add('gradient-buttons');
	}
	if (document.querySelectorAll('[class*="badge"], [class*="pill"], [class*="chip"], [class*="tag"]').length >= 2) accentTreatments.add('pill-badges');

	return { hasBlobs, hasGradientBgs, hasPatterns, illustrationStyle, svgRatio, photoRatio, backgroundEffects: Array.from(backgroundEffects), accentTreatments: Array.from(accentTreatments) };
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
		breakpoints: Array.from(breakpoints).sort((a, b) => toPx(a) - toPx(b)).slice(0, 5),
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
