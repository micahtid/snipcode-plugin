/**
 * inspect/schema/blueprint-button.ts: the page's button variants, as full specs.
 *
 * Runs during the page-scoped inspect pass, against the live dom.
 *
 * The candidate pool is every button and every anchor, and a geometric gate decides which of
 * them is a button. Matching on class names instead, looking for "btn" or "cta", finds nothing
 * on a page whose classes are utility soup or hashed, which is most framework builds.
 *
 * Every value in a blueprint crosses the same gate the token list does. They are two paths to
 * one reader, and a radius printed as 3.35544e+07px here beside a clean 9999px there is the
 * schema disagreeing with itself.
 */
import { isElementVisible } from './classify';
import { hexToRgb, isTransparentColor, oklabDistance, rgbToOklab } from '../../utils/color';
import { effectiveBackground, groupBy, normalizeColor, paddingShorthand, paintedShadow, radiusShorthand, type WalkedElement } from './shared';
import type { ButtonBlueprint, StateRule } from './types';

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

/**
 * Extracts the top button variants with their full visual spec and hover/active states.
 *
 * Ranking is by prominence rather than frequency: the area a button occupies, weighted by how
 * far its fill sits from what is behind it. Frequency alone
 * picked out whatever tiny unstyled node a framework repeated most, and reported a
 * zero-padding grey box as the page's primary button.
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
