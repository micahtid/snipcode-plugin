/**
 * features/states-anchor.ts: how a state effect is re-anchored to the artifact
 *
 * Pipeline position: reconcile, a helper shared by both state paths
 * Reads from Captured: nothing
 * Writes to Captured: nothing
 *
 * Why this exists: a captured state selector is written against the live page's classes and
 * ancestor chain, which the emitters rewrite and the artifact does not carry. Both state
 * paths solve that the same way, by tagging each element with a unique data-* marker and
 * rebuilding the selector from those markers joined by a combinator that is true for the
 * concrete pair. The marker name and the combinator rule are that shared contract, so they
 * live here rather than in either path.
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
 * @param left - the earlier marked element
 * @param right - the later marked element
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
