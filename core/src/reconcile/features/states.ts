/**
 * features/states.ts: choosing how the interactive states are reproduced.
 *
 * A resting capture drops :hover, :focus, :focus-visible, :focus-within, and :active, because
 * el.matches('.btn:hover') is false at rest. The form-state pseudos are not affected: they
 * reflect dom state and are captured correctly at rest.
 *
 * This file is only the choice between two sources. states-measured.ts emits the literals
 * capture measured live; states-copied.ts falls back to the page's authored rules. Both
 * re-anchor through the marker contract in states-anchor.ts.
 *
 * Two things a naive re-emit gets wrong, which both paths handle. Resting values ship as inline
 * styles, which outrank every selector, so state declarations are emitted !important. The
 * selector matches only while the state is active, so it still reverts cleanly. And a captured
 * selector names the live page's classes, so each element re-anchors to a marker instead.
 *
 * One boundary is irreducible: a trigger outside the snipped subtree cannot be reproduced,
 * because the artifact has nothing to force. That is dropped with a warning.
 */
import type { Captured } from '../../types';
import { applyMeasured } from './states-measured';
import { applyCopied } from './states-copied';

/**
 * Reproduces the page's interactive states, preferring the live measurement when capture
 * produced one.
 *
 * @param captured - clone is mutated in place: markers and an appended <style>
 */
export function apply(captured: Captured): Captured {
	if (captured.measuredStates !== null) return applyMeasured(captured, captured.measuredStates);
	return applyCopied(captured);
}
