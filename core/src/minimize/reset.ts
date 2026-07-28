/**
 * minimize/reset.ts: hoisting the lines everyone writes once to the top.
 *
 * Runs in minimize, after var inlining and before the closing prune rerun. Reconcile bakes
 * box-sizing onto every rule and repeats the same link, list, and button zeroing element after
 * element. This injects the canonical reset so the prune that follows can delete those
 * restatements.
 *
 * Each line is an addition candidate, the reverse of prune's deletion: inserted at the top and
 * kept only when the oracle confirms no element's render moved. A low-specificity selector is
 * overridden by any real rule, so a deviant element keeps its own and vetoes nothing.
 *
 * Lines stay one property wide, because acceptance is all or nothing per line and one deviant
 * element would otherwise veto a coarse line and lose the rest with it.
 */
import type { Captured } from '../types';
import { withOracle, type RenderOracle } from './oracle';
import { serializeRules } from './declarations';

/**
 * The canonical minimal reset, each line a widely known human idiom kept fine grained so a
 * deviant element vetoes only its own line. Injected one at a time and kept only when
 * render-neutral, so the output never gains a rule that shifts it.
 */
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
 * Injects the canonical reset lines the oracle confirms are render-neutral at the top of the
 * sheet. It is graceful by contract, returning the input unchanged on any infrastructure
 * failure. It is deterministic, so the reset lines are tried in a fixed order. The redundant
 * per-rule restatements this makes removable are dropped by the prune pass that runs after it.
 *
 * @param captured - source of the viewport size. Warnings are appended here on skip.
 * @returns the stylesheet with the accepted reset lines prepended, or the input unchanged
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
 * Whether an injected reset line left the render unchanged. An element-scoped line, `a` or
 * `button`, can change only the elements its selector matches and their descendants, so it is
 * verified against just that subtree, far cheaper than reading the whole render for each of the
 * many element-scoped lines. The universal `*` line reaches every element, so it is checked
 * against the whole render. A selector that will not parse falls back to the same whole-render
 * check. Subtree soundness is the same one the prune and logical phases rely on (see subtreeTargets).
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
