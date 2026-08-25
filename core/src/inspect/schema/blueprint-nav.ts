/**
 * inspect/schema/blueprint-nav.ts: the page navigation's spec.
 *
 * Runs during the page-scoped inspect pass, against the live dom. Reports the bar's fill,
 * position, height, backdrop blur, bottom border, arrangement, and link count.
 *
 * Which element is the bar is decided in discovery.ts, by geometry rather than document order.
 * What a reader means by the nav is the bar at the top, not whichever `nav` element a
 * framework emitted first.
 */
import { contentChildren, contentRoot } from './boxes';
import { normalizeColor } from './shared';
import type { NavBlueprint } from './types';

/** Extracts the page navigation's spec: bg, position, blur, border, layout, and link count. */
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
 * computed style in most engines, and testing an absent property against 'none' is true. That
 * reported every nav on every page as blurred.
 */
function hasBackdropBlur(computed: CSSStyleDeclaration): boolean {
	const prefixed = (computed as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter;
	return [computed.backdropFilter, prefixed].some((value) => typeof value === 'string' && value !== '' && value !== 'none');
}
