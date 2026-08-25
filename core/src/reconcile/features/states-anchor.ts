/**
 * features/states-anchor.ts: how a state effect is re-anchored to the artifact.
 *
 * Shared by both state paths. A captured selector names the live page's classes and ancestor
 * chain, which the emitters rewrite and the artifact does not carry. So both paths tag each
 * element with a unique data-* marker and rebuild the selector from those. The marker name and
 * the combinator rule are that contract.
 */
import type { Combinator } from '../selector';

/** The attribute a re-anchored state selector keys on. A data-* attribute survives every emitter. */
export const MARKER = 'data-snip-state';

/**
 * The combinator expressing how two marked elements relate. Each marker is unique, so a looser
 * combinator cannot reach a wrong element and the only requirement is that it hold for this
 * pair. Descendant when right is inside left, general-sibling when they share a parent and
 * left comes first. Anything else, an "uncle" say, no single combinator expresses.
 *
 * @returns the generalized combinator, or null if the relationship is inexpressible
 */
export function generalize(left: Element, right: Element): Combinator | null {
	if (left !== right && left.contains(right)) return ' ';
	if (left.parentElement && left.parentElement === right.parentElement) {
		const followsLeft = (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
		if (followsLeft) return '~';
	}
	return null;
}
