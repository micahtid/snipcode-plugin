/**
 * features/states-anchor.ts: how a state effect is re-anchored to the artifact.
 *
 * Shared by both state paths. A captured state selector is written against the live page's
 * classes and ancestor chain, which the emitters rewrite and the artifact does not carry, so
 * both paths tag each element with a unique data-* marker and rebuild the selector from those
 * markers joined by a combinator true for the concrete pair. The marker name and the
 * combinator rule are that shared contract.
 */
import type { Combinator } from '../selector';

/** The attribute a re-anchored state selector keys on. A data-* attribute survives every emitter. */
export const MARKER = 'data-snip-state';

/**
 * The combinator that safely expresses the relationship between two marked elements in
 * the artifact. Because each marker is unique, a looser combinator cannot match a wrong
 * element, so the only requirement is that it be true for this concrete pair. It is descendant
 * when right is contained in left, and general-sibling when they share a parent and left
 * precedes right. Any other relationship, such as an "uncle", is not expressible by a single
 * combinator, so the caller drops the branch.
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
