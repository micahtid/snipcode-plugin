/**
 * features/effects.ts: filters, masks, clip-path, blend, shadow
 *
 * Pipeline position: reconcile
 * Reads from Captured: root, clone, bakedStyles
 * Writes to Captured: bakedStyles + clone, baking non-default effect properties
 *
 * Principles applied: this extends the "ship what renders" rule to the
 * visual-effect properties the authored cascade often omits.
 *
 * CSS/spec reference: https://developer.mozilla.org/en-US/docs/Web/CSS/filter
 * also covers backdrop-filter, clip-path, mask, mix-blend-mode, box-shadow.
 * Detection criterion: an element with a non-default value for one of the effect
 * properties. Otherwise it early-returns per element.
 * Transform contract: it bakes those computed values onto the matching clone
 * element, absolutizing any url(), for example in mask-image or clip-path:
 * url(#...). It mutates bakedStyles and the clone inline styles only.
 *
 * Why this exists: filter, backdrop-filter, clip-path, mask, mix-blend-mode, and
 * multi-layer or inset box-shadow are central to a component's look, but they are
 * frequently applied through a class that does not survive. So without baking, the
 * snip loses its blur, glass, or clipped shape. These properties are per-frame
 * stable, so baking the computed value is pixel-safe.
 */
import type { Captured } from '../../types';
import { pairedSubtrees } from '../match';
import { absolutizeUrls } from './urls';

/**
 * The visual-effect properties this handler preserves. This is the bounded css-spec
 * surface for filters, masking, and compositing, a feature-handler spec set rather
 * than a hardcoded property list. Vendor-prefixed forms are included because chrome
 * still computes some masks and clips under -webkit-.
 */
const EFFECT_PROPS = [
	'filter', 'backdrop-filter', '-webkit-backdrop-filter',
	'clip-path', '-webkit-clip-path',
	'mask', 'mask-image', '-webkit-mask', '-webkit-mask-image',
	'mix-blend-mode', 'background-blend-mode', 'box-shadow',
];

/**
 * Whether an effect value paints nothing, so baking it would add a declaration that changes
 * nothing. Unlike the animation check this needs no property name: every effect property in
 * EFFECT_PROPS spells "no effect" the same three ways.
 */
function isEffectDefault(value: string): boolean {
	const v = value.trim();
	return v === '' || v === 'none' || v === 'normal';
}

/**
 * Bakes non-default visual-effect properties onto each element.
 *
 * @param captured - bakedStyles + clone are mutated in place
 */
export function apply(captured: Captured): Captured {
	const base = document.baseURI || location.href;
	for (const [original, clone] of pairedSubtrees(captured.root, captured.clone)) {
		const computed = getComputedStyle(original);
		const baked = captured.bakedStyles.get(clone) ?? new Map<string, string>();
		for (const prop of EFFECT_PROPS) {
			if (baked.has(prop)) continue;
			const raw = computed.getPropertyValue(prop);
			if (isEffectDefault(raw)) continue;
			const value = raw.includes('url(') ? absolutizeUrls(raw, base) : raw;
			baked.set(prop, value);
			try {
				(clone as HTMLElement).style.setProperty(prop, value);
			} catch {
				// Invalid for this element, so skip it.
			}
		}
		captured.bakedStyles.set(clone, baked);
	}
	return captured;
}

