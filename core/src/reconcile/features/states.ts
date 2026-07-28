/**
 * features/states.ts: choosing how the interactive states are reproduced.
 *
 * A resting capture drops :hover, :focus, :focus-visible, :focus-within, and :active, because
 * el.matches('.btn:hover') is false at rest, so each property flattens to its resting value.
 * The form-state pseudos are excluded: they reflect current dom state and are captured at rest.
 *
 * This file is only the choice between two sources. When capture measured the states live it
 * emits those concrete literals, in features/states-measured.ts. When measurement did not run
 * it falls back to copying the page's authored rules, in features/states-copied.ts. The marker
 * contract both re-anchor through is features/states-anchor.ts.
 *
 * Two things a naive re-emit gets wrong, which both paths handle. A resting value ships as an
 * inline style, and a normal inline declaration outranks every selector, so a state rule in a
 * <style> block does nothing unless it is !important; state declarations are therefore emitted
 * !important, and since the selector matches only while the state is active it reverts cleanly
 * at rest. And a captured selector names the live page's classes and ancestors, so each element
 * is re-anchored to a data-snip-state marker instead.
 *
 * One boundary is irreducible: a trigger outside the snipped subtree cannot be reproduced,
 * because the artifact does not contain the thing to force. That is dropped with a warning.
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
