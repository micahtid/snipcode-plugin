/**
 * features/effects.ts: filters, masks, clip-path, blend modes, and shadows.
 *
 * Bakes the non-default effect properties, absolutizing any url() a mask or clip-path names.
 * These are central to how a component looks and usually arrive through a class that does not
 * travel. Without baking, the snip loses its blur, glass, or clipped shape. They are per-frame
 * stable, so baking the computed value is pixel-safe.
 */
import type { Captured } from '../../types';
import { pairedSubtrees, setBaked } from '../match';
import { absolutizeUrls } from '../../utils/css-urls';

/**
 * The visual-effect properties this handler preserves. Prefixed forms are included because
 * chrome still computes some masks and clips under -webkit-.
 */
const EFFECT_PROPS = [
	'filter', 'backdrop-filter', '-webkit-backdrop-filter',
	'clip-path', '-webkit-clip-path',
	'mask', 'mask-image', '-webkit-mask', '-webkit-mask-image',
	'mix-blend-mode', 'background-blend-mode', 'box-shadow',
];

/**
 * Whether an effect value paints nothing. No property name needed, unlike the animation check:
 * every property in EFFECT_PROPS spells "no effect" the same three ways.
 */
function isEffectDefault(value: string): boolean {
	const v = value.trim();
	return v === '' || v === 'none' || v === 'normal';
}

/** Bakes non-default visual-effect properties. bakedStyles + clone are mutated in place. */
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
			setBaked(clone, baked, prop, value);
		}
		captured.bakedStyles.set(clone, baked);
	}
	return captured;
}

