/**
 * features/animation.ts: the transform and animation context.
 *
 * Bakes non-default transform-origin, perspective, the 3d flags, and the animation and
 * transition shorthands, which the authored cascade often omits yet which shape the frame.
 *
 * It deliberately does not re-bake transform itself, or translate/rotate/scale: those can be
 * mid-animation at capture time, and the per-element pass already owns the value. Baking a
 * mid-flight frame would lock the element to it.
 */
import type { Captured } from '../../types';
import { pairedSubtrees, setBaked } from '../match';

/** The transform-context and animation properties preserved. `transform` is deliberately absent. */
const ANIM_CONTEXT_PROPS = [
	'transform-origin', 'perspective', 'perspective-origin', 'transform-style', 'backface-visibility',
	'animation', 'transition', 'transition-timing-function', 'animation-timing-function', 'will-change',
];

/** Whether an animation-context value is the resting default, so baking it would add nothing. */
function isAnimationDefault(prop: string, value: string): boolean {
	const v = value.trim();
	if (v === '' || v === 'none' || v === 'auto' || v === 'normal') return true;
	if (prop === 'perspective' && v === 'none') return true;
	if (prop === 'transform-style' && v === 'flat') return true;
	if (prop === 'backface-visibility' && v === 'visible') return true;
	if (prop === 'will-change' && v === 'auto') return true;
	// A zeroed transition (0s) has no effect at rest.
	if (prop === 'transition' && /^all 0s ease 0s$|^0s\b/.test(v)) return true;
	return false;
}

/** Bakes non-default transform-context and animation declarations. Mutates bakedStyles + clone. */
export function apply(captured: Captured): Captured {
	for (const [original, clone] of pairedSubtrees(captured.root, captured.clone)) {
		const computed = getComputedStyle(original);
		const baked = captured.bakedStyles.get(clone) ?? new Map<string, string>();
		for (const prop of ANIM_CONTEXT_PROPS) {
			if (baked.has(prop)) continue;
			const value = computed.getPropertyValue(prop);
			if (isAnimationDefault(prop, value)) continue;
			setBaked(clone, baked, prop, value);
		}
		captured.bakedStyles.set(clone, baked);
	}
	return captured;
}
