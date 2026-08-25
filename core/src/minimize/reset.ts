/**
 * minimize/reset.ts: hoisting the lines everyone writes once to the top.
 *
 * Runs in minimize, after var inlining and before the closing prune rerun. Reconcile repeats
 * the same box-sizing, link, list, and button zeroing element after element, so injecting the
 * canonical reset lets the prune that follows delete those restatements.
 *
 * Each line is an addition candidate, the reverse of prune's deletion: inserted at the top and
 * kept only when the oracle sees no element move. Its selector is low-specificity, so a
 * deviant element keeps its own rule and vetoes nothing.
 *
 * Lines stay one property wide, because acceptance is all or nothing per line. A coarse line
 * would let one deviant element veto the rest along with it.
 */
import type { Captured } from '../types';
import { withOracle, type RenderOracle } from './oracle';
import { serializeRules } from './declarations';

/** The canonical minimal reset, one idiom per line so a deviant element vetoes only that line. */
const RESET_RULES = [
	'*, *::before, *::after { box-sizing: border-box; }',
	'button, input, select, textarea { font: inherit; color: inherit; }',
	'a { color: inherit; }',
	'a { text-decoration: none; }',
	'a { cursor: pointer; }',
	'button { cursor: pointer; }',
	'button { background: none; }',
	'button { border: none; }',
	'button { padding: 0; }',
	'ul, ol { list-style: none; }',
	'ul, ol { margin: 0; }',
	'ul, ol { padding: 0; }',
];

/**
 * Prepends the reset lines the oracle confirms are render-neutral. Tried in a fixed order, so
 * the result is deterministic, and any infrastructure failure returns the input unchanged. The
 * restatements this makes removable are dropped by the prune pass that runs after.
 *
 * @param captured - source of the viewport size. Warnings are appended here on skip.
 */
export async function injectReset(css: string, captured: Captured, markup: string): Promise<string> {
	return withOracle(css, captured, markup, 'minimize: reset skipped', (oracle) => {
		oracle.captureReference();
		let injected = 0;
		for (const rule of RESET_RULES) {
			try {
				oracle.sheet.insertRule(rule, injected); // Keep accepted resets first, in order.
			} catch {
				continue; // Unparseable in this engine, so skip it.
			}
			if (renderNeutral(oracle, rule)) injected++;
			else oracle.sheet.deleteRule(injected); // Not neutral here, so do not inject.
		}
		if (injected === 0) return css;
		return serializeRules(Array.from(oracle.sheet.cssRules));
	});
}

/**
 * Whether an injected reset line left the render unchanged. An element-scoped line reaches only
 * what its selector matches, plus descendants, so it is checked against that subtree alone, far
 * cheaper than reading the whole render each time. The universal `*` line, and any selector
 * that will not parse, falls back to the whole render. Soundness is subtreeTargets'.
 */
function renderNeutral(oracle: RenderOracle, rule: string): boolean {
	const selector = rule.slice(0, rule.indexOf('{')).trim();
	if (selector.includes('*')) return oracle.matchesReference();
	let elements: Element[];
	try {
		elements = Array.from(oracle.body.querySelectorAll(selector));
	} catch {
		return oracle.matchesReference();
	}
	return oracle.matchesSubset(oracle.subtreeTargets(elements));
}
