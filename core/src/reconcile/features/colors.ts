/**
 * features/colors.ts: putting currentColor back.
 *
 * getComputedStyle resolves currentColor on fill, stroke, and border to a literal, which
 * severs the link to `color`, so an icon that should recolor with its text no longer does.
 * Where the baked literal equals the element's resolved color, this rewrites it back to the
 * keyword. Pixel-identical, and it keeps the link for any state rule added later.
 *
 * Modern color notations need nothing here: reconcile keeps the authored value when it
 * round-trips, and otherwise ships the computed value in the same color space.
 */
import type { Captured } from '../../types';
import { pairedSubtrees } from '../match';

/**
 * Svg paint properties that default to currentColor. This is the bounded css-spec
 * surface for the icon-recolor mechanism, a feature-handler spec set rather than a
 * hardcoded property list. The border and outline color literals are deliberately
 * left alone, because rewriting them to currentColor risks serialization drift for
 * no rendering gain, and the icon case is what matters.
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
			// Only collapse an exact literal match. Never touch authored color
			// functions like oklch or color-mix, because reconcile already preserved those.
			if (value && value === colorLiteral) {
				baked.set(prop, 'currentColor');
				try {
					(clone as HTMLElement).style.setProperty(prop, 'currentColor');
				} catch {
					// Invalid for this element, so skip it.
				}
			}
		}
	}
	return captured;
}
