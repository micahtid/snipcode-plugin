/**
 * inspect/schema/blueprint-card.ts: the page's card variants, as full specs.
 *
 * Runs during the page-scoped inspect pass, against the live dom. Reports each variant's fill,
 * radius, border, shadow, padding, hover state, and the order of the blocks inside it.
 */
import { classNameOf } from './classify';
import { contentRoot } from './boxes';
import { groupBy, normalizeColor, paddingShorthand, paintedShadow, radiusShorthand, type WalkedElement } from './shared';
import type { CardBlueprint, StateRule } from './types';

/** How many of a card's blocks the inner-layout string names. */
const MAX_CARD_PARTS = 6;
/** How many card variants one page reports. */
const MAX_CARD_VARIANTS = 3;

/** Extracts the top card variants with their visual spec, hover state, and inner layout. */
export function extractCardBlueprints(walked: WalkedElement[], states: StateRule[]): CardBlueprint[] {
	const cards = walked.filter((el) => el.role === 'card');
	if (cards.length === 0) return [];

	const groups = groupBy(cards, (card) => card.fingerprint);
	const sorted = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length).slice(0, MAX_CARD_VARIANTS);

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
