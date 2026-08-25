/**
 * features/queries.ts: keeping the container context a container query resolves against.
 *
 * @media needs nothing: match.ts only admits rules whose query currently applies, so colour
 * scheme, reduced motion, and breakpoint variants are already resolved to the captured
 * viewport and baked as computed values.
 *
 * @container does. A descendant's query resolves against an ancestor's containment context,
 * which is lost if container-type is not preserved, so it is baked. features/units.ts locks
 * the container's width, so the two cooperate.
 */
import type { Captured } from '../../types';
import { pairedSubtrees, setBaked } from '../match';

/** Preserves the container-type containment context. bakedStyles + clone are mutated in place. */
export function apply(captured: Captured): Captured {
	for (const [original, clone] of pairedSubtrees(captured.root, captured.clone)) {
		const computed = getComputedStyle(original);
		const containerType = computed.getPropertyValue('container-type');
		// `normal` is the default, meaning no containment, so there is nothing to preserve.
		if (!containerType || containerType === 'normal') continue;

		const baked = captured.bakedStyles.get(clone) ?? new Map<string, string>();
		bake(clone, baked, 'container-type', containerType);
		const name = computed.getPropertyValue('container-name');
		if (name && name !== 'none') bake(clone, baked, 'container-name', name);
		captured.bakedStyles.set(clone, baked);
	}
	return captured;
}

/** Record a value in the baked map and on the clone's inline style, unless already baked. */
function bake(clone: Element, baked: Map<string, string>, prop: string, value: string): void {
	if (!baked.has(prop)) setBaked(clone, baked, prop, value);
}
