/**
 * features/states.ts: interactive-state rules (:hover, :focus, :active)
 *
 * Pipeline position: reconcile
 * Reads from Captured: root, clone, measuredStates, foundationRules, componentRules, bakedStyles
 * Writes to Captured: clone, marking elements and appending a <style> of state rules, and warnings
 *
 * This extends the "ship what renders" approach to the interactive states a static
 * snapshot drops, such as a button that lightens on hover, a link that underlines, and an
 * input that rings on focus. The resting cascade discards them because the element is not
 * hovered or focused at capture time, since el.matches('.btn:hover') is false at rest, so
 * each property flattens to its resting value. This handler re-emits them so they reproduce
 * in the standalone artifact.
 *
 * There are two sources of truth, and this handler prefers ground truth. When the capture
 * phase measured the states live (meaning capture/states-measure.ts forced each state and read
 * what actually computed, so captured.measuredStates is non-null), this emits those concrete
 * literals. The engine already resolved the cascade, the inheritance, and every group-hover,
 * descendant, and sibling relationship, so there is nothing left to parse. When measurement did
 * not run (meaning cdp was busy, so measuredStates is null), it falls back to copying the page's
 * authored state rules and re-anchoring their selectors. That reproduces the common case of an
 * element's own `:hover`, but it cannot follow a relationship a framework encodes out of reach.
 *
 * This file is only that choice. The measured path is features/states-measured.ts, the copied
 * fallback is features/states-copied.ts, and the marker contract both re-anchor through is
 * features/states-anchor.ts.
 *
 * CSS/spec reference: https://developer.mozilla.org/en-US/docs/Web/CSS/:hover, plus
 * :focus, :focus-visible, :focus-within, and :active. The trigger set is the closed spec
 * category of dynamic interactive pseudo-classes. The form-state pseudos such as :checked
 * and :disabled are excluded because they reflect current dom state and are already captured
 * at rest.
 *
 * Why a naive re-emit gets it wrong, and how both paths answer it:
 *  - A resting value ships as an inline style attribute, and a normal inline declaration
 *    outranks every normal selector, since it is resolved before specificity is consulted. So a
 *    state rule in a <style> block has zero effect unless it is !important. This is the same
 *    reason the email inliner juice keeps :hover in a surviving <style>. State declarations are
 *    therefore emitted !important. Because the state selector matches only while the state is
 *    active, the override applies only during interaction and reverts cleanly at rest.
 *  - A captured selector (`body.dark .nav > .btn:hover`) is written against the live page's
 *    classes and ancestor chain, which the emitters rewrite and the artifact does not carry.
 *    Each marked element is re-anchored to a unique data-snip-state marker, a data-* attribute,
 *    so it survives the tailwind and bem emitters that rewrite class. The markers are joined by
 *    a combinator that is sound because the markers are unique. It is descendant when the
 *    trigger contains the affected element, and general-sibling when they share a parent and the
 *    trigger precedes it.
 *  - There is one irreducible boundary. A state whose trigger element is outside the snipped
 *    subtree (`.outside:hover .snipped`) cannot be reproduced, because the artifact does not
 *    contain the thing to force. That effect is dropped with a warning, never a silent or wrong
 *    result.
 *
 * Transform contract: it tags each marked, in-subtree element with a data-snip-state marker and
 * adds `[data-snip-state="n"]:hover {...}` rules, denoised against the resting baked value and
 * emitted !important, to the clone's shared synthesized <style>. See reconcile/synthesized.ts.
 * It touches the clone only. State selectors match nothing at rest, so the resting render is
 * byte-identical.
 * Test fixtures: tests/fixtures/state-{card,form,var,localvar,url,pseudo,transform}.html,
 * registered in tests/fixtures.mjs. The gate measures the resting, state-inactive render.
 */
import type { Captured } from '../../types';
import { applyMeasured } from './states-measured';
import { applyCopied } from './states-copied';

/**
 * Reproduces the page's interactive states on the clone, preferring the live measurement
 * when the capture phase produced one and falling back to copying authored rules otherwise.
 *
 * @param captured - clone is mutated in place: markers and an appended <style>
 */
export function apply(captured: Captured): Captured {
	if (captured.measuredStates !== null) return applyMeasured(captured, captured.measuredStates);
	return applyCopied(captured);
}
