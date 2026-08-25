/**
 * features/colors.ts: putting currentColor back.
 *
 * getComputedStyle resolves currentColor on fill, stroke, and border to a literal, severing
 * the link to `color`. An icon that should recolor with its text then no longer does. Where
 * the baked literal equals the element's resolved color, this rewrites it back to the keyword.
 * Pixel-identical, and it keeps the link for any state rule added later.
 *
 * Modern color notations need nothing here: reconcile keeps the authored value when it
 * round-trips, and otherwise ships the computed value in the same color space.
 */
import type { Captured } from '../../types';
import { pairedSubtrees, setBaked } from '../match';

/**
 * The svg paint properties that default to currentColor, which is the whole of the
 * icon-recolor mechanism. Border and outline color literals are left alone: rewriting them
 * risks serialization drift for no rendering gain.
 */
const COLOR_PROPS = ['fill', 'stroke'];

/**
 * Restores currentColor where a color-ish property's literal equals `color`.
 *
 * @param captured - bakedStyles + clone are mutated in place
 */
export function apply(captured: Captured): Captured {
	for (const [original, clone] of pairedSubtrees(captured.root, captured.clone)) {
		const baked = captured.bakedStyles.get(clone);
		if (!baked) continue;
		const colorLiteral = getComputedStyle(original).getPropertyValue('color');
		if (!colorLiteral) continue;
		for (const prop of COLOR_PROPS) {
			const value = baked.get(prop);
			// Exact literal match only. An authored oklch or color-mix is left as reconcile
			// preserved it.
			if (value && value === colorLiteral) setBaked(clone, baked, prop, 'currentColor');
		}
	}
	return captured;
}
