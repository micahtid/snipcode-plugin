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
 */
import { classNameOf } from './classify';
import { groupBy, isTransparentColor, normalizeColor, paddingShorthand, type WalkedElement } from './shared';
import type { ButtonBlueprint, CardBlueprint, DecorativeInfo, NavBlueprint, ResponsiveInfo, StateRule } from './types';

/** Extracts the top button variants with their full visual spec and hover/active states. */
export function extractButtonBlueprints(walked: WalkedElement[], states: StateRule[]): ButtonBlueprint[] {
	const buttons = walked.filter((el) => el.role === 'button');
	if (buttons.length === 0) return [];

	const groups = groupBy(buttons, (btn) => btn.fingerprint);
	const sorted = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length).slice(0, 4);

	const pageBg = normalizeColor(window.getComputedStyle(document.body).backgroundColor) || '#ffffff';
	const blueprints: ButtonBlueprint[] = [];

	for (let i = 0; i < sorted.length; i++) {
		const rep = sorted[i]![1][0]!;
		const computed = window.getComputedStyle(rep.element);
		const bg = normalizeColor(computed.backgroundColor) || 'transparent';
		const color = normalizeColor(computed.color) || '#000000';
		const shadow = computed.boxShadow !== 'none' ? computed.boxShadow : '';
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
			borderRadius: computed.borderRadius,
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

	// Disambiguate any variant names that collided.
	const seen = new Set<string>();
	for (const bp of blueprints) {
		if (seen.has(bp.variant)) bp.variant = `${bp.variant}-${seen.size}`;
		seen.add(bp.variant);
	}

	return blueprints;
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
			borderRadius: computed.borderRadius,
			shadow: computed.boxShadow !== 'none' ? computed.boxShadow : 'none',
			border: computed.borderWidth !== '0px' && computed.borderStyle !== 'none' ? `${computed.borderWidth} ${computed.borderStyle} ${computed.borderColor}` : 'none',
			padding: paddingShorthand(computed),
			hover,
			innerLayout: detectCardInnerLayout(rep.element),
		});
	}

	return blueprints;
}

/** Describes a card's inner layout as an ordered "image + heading + text" string. */
function detectCardInnerLayout(el: Element): string {
	const parts: string[] = [];
	for (let i = 0; i < Math.min(el.children.length, 6); i++) {
		const child = el.children[i]!;
		const tag = child.tagName.toLowerCase();
		const classList = classNameOf(child);
		if (tag === 'img' || tag === 'picture' || tag === 'video' || /image|thumbnail|cover/.test(classList)) parts.push('image');
		else if (/^h[1-6]$/.test(tag)) parts.push('heading');
		else if (tag === 'p') parts.push('text');
		else if (tag === 'svg' || /icon/.test(classList)) parts.push('icon');
		else if (tag === 'button' || /btn|button/.test(classList)) parts.push('button');
		else if (child.children.length > 0) parts.push('body');
	}
	return parts.length > 0 ? parts.join(' + ') : 'unknown';
}

/** Extracts the page navigation's spec: bg, position, blur, border, layout, and link count. */
export function extractNavBlueprint(): NavBlueprint | null {
	const nav = document.querySelector('nav') || document.querySelector('header nav') || document.querySelector('[role="navigation"]');
	if (!nav) return null;

	const computed = window.getComputedStyle(nav);
	const links = nav.querySelectorAll('a');
	const border = computed.borderBottomWidth !== '0px' && computed.borderBottomStyle !== 'none' ? `${computed.borderBottomWidth} ${computed.borderBottomStyle} ${computed.borderBottomColor}` : 'none';

	let layout = 'unknown';
	if (nav.children.length >= 2) {
		const hasLogo = nav.querySelector('[class*="logo"], a:first-child img, a:first-child svg');
		const hasCta = nav.querySelector('[class*="cta"], [class*="btn"], button');
		const hasLinks = links.length >= 3;
		if (hasLogo && hasLinks && hasCta) layout = 'logo-left + links-center + cta-right';
		else if (hasLogo && hasLinks) layout = 'logo-left + links-right';
		else if (hasLogo && hasCta) layout = 'logo-left + cta-right';
		else if (hasLogo) layout = 'logo-left';
	}

	return {
		bg: normalizeColor(computed.backgroundColor) || 'transparent',
		position: computed.position,
		height: computed.height,
		blur: computed.backdropFilter !== 'none' || (computed as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter !== 'none',
		border,
		layout,
		linkCount: links.length,
	};
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

/** Reads the page's responsive behavior from its media queries. */
export function extractResponsiveInfo(rules: CSSRule[]): ResponsiveInfo {
	const breakpoints = new Set<string>();
	let mobileNavStyle = 'unchanged';
	let gridCollapseBehavior = 'stack';

	for (const rule of rules) {
		if (!(rule instanceof CSSMediaRule)) continue;
		const media = rule.conditionText || rule.media?.mediaText || '';
		const widthMatch = media.match(/(?:max|min)-width:\s*(\d+(?:\.\d+)?(?:px|em|rem))/);
		if (widthMatch) breakpoints.add(widthMatch[1]!);

		const ruleText = Array.from(rule.cssRules || []).map((r) => (r instanceof CSSStyleRule ? r.cssText : '')).join(' ');
		if (/nav.*display:\s*none|\.nav-links.*display:\s*none|\.menu.*display:\s*none/.test(ruleText)) mobileNavStyle = 'hamburger';
		if (/grid-template-columns:\s*1fr\b/.test(ruleText)) gridCollapseBehavior = 'stack';
		else if (/overflow-x:\s*(?:auto|scroll)/.test(ruleText)) gridCollapseBehavior = 'scroll';
		else if (/grid-template-columns:\s*repeat\(2/.test(ruleText)) gridCollapseBehavior = 'reduce-columns';
	}

	return { breakpoints: Array.from(breakpoints).sort((a, b) => parseFloat(a) - parseFloat(b)).slice(0, 5), mobileNavStyle, gridCollapseBehavior };
}
