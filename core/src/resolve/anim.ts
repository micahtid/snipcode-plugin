/**
 * resolve/anim.ts: keeping only the keyframes the snip animates with.
 *
 * Runs during resolve. Animation values are already baked onto the elements, but the
 * @keyframes blocks they name live in stylesheets that do not travel with the snip. This
 * pairs the two and drops every block nothing references.
 */
import type { Captured } from '../types';

/**
 * Narrows captured @keyframes to those named by an animation in the baked styles.
 *
 * @param captured - keyframes is replaced in place with the referenced subset
 */
export function resolveAnimations(captured: Captured): void {
	if (captured.keyframes.length === 0) return;
	const referenced = referencedAnimationNames(captured);
	captured.keyframes = captured.keyframes.filter((kf) => referenced.has(kf.name));
}

/**
 * Every token appearing in an animation or animation-name value across the baked styles. The
 * shorthand lists name, duration, and timing in any order. Rather than parse that grammar,
 * this gathers all tokens and lets the caller's keyframe-name intersection pick the real ones.
 * A duration like "2s" can never collide with a keyframe identifier.
 */
function referencedAnimationNames(captured: Captured): Set<string> {
	const tokens = new Set<string>();
	for (const [, baked] of captured.bakedStyles) {
		for (const prop of ['animation', 'animation-name']) {
			const value = baked.get(prop);
			if (!value) continue;
			for (const part of value.split(',')) {
				for (const token of part.trim().split(/\s+/)) {
					const t = token.trim();
					if (t) tokens.add(t);
				}
			}
		}
	}
	return tokens;
}
