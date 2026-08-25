/**
 * capture/states-measure.ts: measuring interactive states by forcing them live.
 *
 * Runs during capture, through the Host. The rest of the pipeline establishes fidelity by
 * measuring, and this is states doing the same. Copying authored :hover rules instead misses
 * what a framework buries (Tailwind compiles `group-hover:` to `:is(:where(.group):hover *)`)
 * and replays parent rules the resting bake already flattened.
 *
 * Forcing the state and reading what computes lets the engine resolve group-hover, descendant,
 * sibling, and inherited effects for free, with no selector grammar to decode. Each scoped
 * element is read on two layers, its own box and any generating pseudo, which is where the
 * common glow and underline idioms live.
 *
 * Reads run under a temporary transitions-off shim, so each value is the state's final one
 * rather than a mid-flight frame, and the page is restored even on error. With no protocol the
 * snip proceeds and reconcile falls back to copying rules.
 */
import type { Captured, MeasuredAffected, MeasuredState, MeasuredStateDecl } from '../types';
import { mediaApplies } from '../reconcile/match';
import { subtreeElements } from '../reconcile/tree';
import { containsDynamicPseudo, findTriggerBearers, safeMatches } from '../reconcile/selector';
import { getHost } from '../host';

/** Unique per-trigger tag so the background can resolve exactly one element to force. */
const FORCE_TAG = 'data-snipcode-force';

/** The transitions-off/animations-off shim that makes the forced read instantaneous. */
const SHIM_TEXT = '*, *::before, *::after { transition: none !important; animation: none !important; }';

/**
 * Work budget. Measurement costs a CDP round-trip per trigger-and-state pair plus a computed
 * read per scoped element, so both scale with the snip. Past these bounds, a whole site nav
 * with hundreds of hover rules say, it degrades to the copy path rather than risk a timeout.
 * The bounds are counts, so the measure-or-copy decision is deterministic.
 */
const MAX_MEASURED_UNITS = 200;
const MAX_MEASURED_SCOPE = 2000;

/**
 * Forces every in-subtree interactive state the page's own rules describe and records the
 * concrete computed delta. Sets captured.measuredStates: an array, possibly empty, when
 * measurement ran, or null when cdp was unavailable so reconcile copies authored rules.
 *
 * @param captured - the in-flight capture, with measuredStates + warnings mutated in place
 */
export async function measureInteractiveStates(captured: Captured): Promise<void> {
	const subtree = new Set(subtreeElements(captured.root));
	const triggers = discoverTriggers(captured, subtree);
	// No in-subtree state rule: nothing to force, and no copy fallback is needed either.
	if (triggers.size === 0) {
		captured.measuredStates = [];
		return;
	}

	// Bound the work before doing any of it: too many units means too many round-trips, so
	// degrade to copying rules. Counted before scopes, since that walk also scales with the snip.
	let unitCount = 0;
	for (const states of triggers.values()) unitCount += states.size;
	if (unitCount > MAX_MEASURED_UNITS) {
		captured.warnings.push(`states: ${unitCount} interactive-state rules exceed the measurement budget; falling back to copying authored rules`);
		captured.measuredStates = null;
		return;
	}

	// Each trigger reads only its re-anchorable scope, so the resting baseline covers those
	// elements rather than the whole subtree. A large snip with few triggers stays cheap.
	const scopes = new Map<Element, Element[]>();
	const toBaseline = new Set<Element>();
	for (const trigger of triggers.keys()) {
		const scope = triggerScope(trigger, subtree);
		scopes.set(trigger, scope);
		for (const el of scope) toBaseline.add(el);
	}
	// Bound the computed reads too. A generating pseudo adds a read at the baseline and under
	// every forced state, so it counts toward the bound; an element-only budget would
	// undercount a pseudo-heavy snip. The layers resolve once here, since content does not
	// depend on the shim, and are reused for every read.
	const generating = new Map<Element, string[]>();
	let scopeCost = 0;
	for (const el of toBaseline) {
		const pseudos = generatingPseudos(el);
		if (pseudos.length > 0) generating.set(el, pseudos);
		scopeCost += 1 + pseudos.length;
	}
	if (scopeCost > MAX_MEASURED_SCOPE) {
		captured.warnings.push(`states: ${scopeCost} element/pseudo layers in interactive-state scope exceed the measurement budget; falling back to copying authored rules`);
		captured.measuredStates = null;
		return;
	}

	const shim = installShim();
	try {
		// The resting baseline is read under the same shim as the forced endpoints, so a
		// steady-state animation cannot read as a spurious change between the two.
		const baseline = new Map<Element, MeasuredBaseline>();
		for (const el of toBaseline) baseline.set(el, readMeasuredLayers(el, generating.get(el)));

		const began = await beginForce();
		if (!began) {
			// Cdp refused because devtools or another client is attached: degrade to copying rules.
			captured.warnings.push('states: live measurement unavailable (cdp busy); falling back to copying authored rules');
			captured.measuredStates = null;
			return;
		}

		const tags = tagTriggers([...triggers.keys()]);
		try {
			captured.measuredStates = await measureAll(triggers, tags, scopes, baseline, captured);
		} finally {
			for (const [el] of tags) el.removeAttribute(FORCE_TAG);
			await endForce();
		}
	} catch (err) {
		captured.warnings.push(`states: live measurement failed (${(err as Error).message}); falling back to copying authored rules`);
		captured.measuredStates = null;
	} finally {
		// endForce has already cleared every forced state. One synchronous recalc while the shim
		// still suppresses transitions materializes the page at rest, so the later resting bake
		// reads resting values only.
		void document.body?.offsetHeight;
		shim.remove();
	}
}

/**
 * Which elements to force and which states on each, read entirely from the page's own state
 * rules rather than any guess about what looks interactive. Every rule carrying a dynamic
 * pseudo, under an applying @media, has its bearer's structural selector matched against the
 * subtree. A match is an element to force, keyed to the pseudos to force together.
 *
 * Bearers group by structural selector, so discovery is one querySelectorAll per distinct
 * selector rather than every rule against every element.
 *
 * @returns each trigger element to the distinct pseudo-sets, in colon form, to force on it
 */
function discoverTriggers(captured: Captured, subtree: Set<Element>): Map<Element, Map<string, string[]>> {
	// The distinct bearers across every state rule, keyed by structural selector.
	const byStructural = new Map<string, Map<string, string[]>>();
	const unparseable = new Set<string>(); // Warn once per selector.
	for (const rule of [...captured.foundationRules, ...captured.componentRules]) {
		if (!containsDynamicPseudo(rule.selector)) continue;
		if (rule.mediaQuery && !mediaApplies(rule.mediaQuery)) continue;
		let bearers;
		try {
			bearers = findTriggerBearers(rule.selector);
		} catch {
			if (!unparseable.has(rule.selector)) {
				unparseable.add(rule.selector);
				captured.warnings.push(`states: unparseable selector "${rule.selector}"; effect dropped`);
			}
			continue;
		}
		for (const bearer of bearers) {
			const structural = bearer.structural || '*';
			const pseudos = canonicalPseudos(bearer.dynamicPseudos);
			const sets = byStructural.get(structural) ?? new Map<string, string[]>();
			sets.set(pseudos.join(''), pseudos);
			byStructural.set(structural, sets);
		}
	}

	// Resolve each distinct selector to the in-subtree elements that bear it.
	const triggers = new Map<Element, Map<string, string[]>>();
	for (const [structural, pseudoSets] of byStructural) {
		for (const el of matchInSubtree(captured.root, structural, subtree)) {
			const states = triggers.get(el) ?? new Map<string, string[]>();
			for (const [key, pseudos] of pseudoSets) states.set(key, pseudos);
			triggers.set(el, states);
		}
	}
	return triggers;
}

/**
 * The subtree elements a structural selector matches. querySelectorAll returns descendants
 * only, so the root is tested separately.
 */
function matchInSubtree(root: Element, structural: string, subtree: Set<Element>): Element[] {
	const out: Element[] = [];
	if (safeMatches(root, structural)) out.push(root);
	let matches: NodeListOf<Element>;
	try {
		matches = root.querySelectorAll(structural);
	} catch {
		return out; // An unsupported selector matches nothing standalone, so drop it.
	}
	for (const el of matches) if (subtree.has(el)) out.push(el);
	return out;
}

/**
 * Forces each trigger-and-state pair one at a time and reads the scope's computed delta, so
 * descendant, sibling, and inherited effects are captured with no relationship parsed. Each
 * state is cleared before the next is forced.
 *
 * @param captured - warnings mutated in place
 * @returns one MeasuredState per pair that changed at least one element
 */
async function measureAll(
	triggers: Map<Element, Map<string, string[]>>,
	tags: Map<Element, string>,
	scopes: Map<Element, Element[]>,
	baseline: Map<Element, MeasuredBaseline>,
	captured: Captured,
): Promise<MeasuredState[]> {
	const measured: MeasuredState[] = [];
	for (const [trigger, states] of triggers) {
		const selector = `[${FORCE_TAG}="${tags.get(trigger)}"]`;
		const scope = scopes.get(trigger) ?? [trigger];
		for (const pseudos of states.values()) {
			const bare = pseudos.map((p) => p.replace(/^:/, ''));
			const set = await forceState(selector, bare);
			if (!set) {
				captured.warnings.push(`states: could not force ${pseudos.join('')} on a trigger; effect dropped`);
				continue;
			}
			const affected = collectAffected(scope, baseline);
			await forceState(selector, []); // Clear before the next state so they stay isolated.
			if (affected.length > 0) measured.push({ trigger, states: pseudos, affected });
		}
	}
	return measured;
}

/**
 * The elements a forced trigger can restyle in a way emit can re-anchor: itself, its
 * descendants, and its following same-parent siblings. A change anywhere else needs more than
 * one combinator between two markers and would be dropped at emit. Not reading it keeps the
 * per-trigger cost proportional to that trigger's scope.
 */
function triggerScope(trigger: Element, subtree: Set<Element>): Element[] {
	const scope: Element[] = [trigger];
	for (const el of trigger.querySelectorAll('*')) if (subtree.has(el)) scope.push(el);
	for (let s = trigger.nextElementSibling; s; s = s.nextElementSibling) if (subtree.has(s)) scope.push(s);
	return scope;
}

/** One scoped element's resting values, split by layer. A pseudo delta then diffs against its
 * own baseline rather than the element's. */
interface MeasuredBaseline {
	element: Map<string, string>;
	pseudos: Map<string, Map<string, string>>;
}

/**
 * One scoped element's resting values across its layers: the element box, plus each generating
 * pseudo passed in pre-resolved. Read under the shim, so it matches the forced reads.
 */
function readMeasuredLayers(el: Element, pseudos: string[] | undefined): MeasuredBaseline {
	const layers: MeasuredBaseline = { element: readMeasuredProps(el), pseudos: new Map() };
	if (pseudos) for (const pseudo of pseudos) layers.pseudos.set(pseudo, readMeasuredProps(el, pseudo));
	return layers;
}

/**
 * The layers that differ from the resting baseline under the currently forced state. The
 * element box is one entry and each generating pseudo is its own, diffed against its own
 * baseline. An unchanged layer contributes nothing.
 *
 * @returns one entry per changed element-and-layer, with its changed properties
 */
function collectAffected(scope: Element[], baseline: Map<Element, MeasuredBaseline>): MeasuredAffected[] {
	const affected: MeasuredAffected[] = [];
	for (const el of scope) {
		const base = baseline.get(el);
		if (!base) continue;
		const elementDecls = diffMeasured(base.element, readMeasuredProps(el));
		if (elementDecls.length > 0) affected.push({ element: el, decls: elementDecls });
		for (const [pseudo, rest] of base.pseudos) {
			const pseudoDecls = diffMeasured(rest, readMeasuredProps(el, pseudo));
			if (pseudoDecls.length > 0) affected.push({ element: el, pseudoElement: pseudo, decls: pseudoDecls });
		}
	}
	return affected;
}

/** The properties whose forced value differs from the resting baseline, one declaration each. */
function diffMeasured(rest: Map<string, string>, forced: Map<string, string>): MeasuredStateDecl[] {
	const decls: MeasuredStateDecl[] = [];
	for (const [property, value] of forced) if (rest.get(property) !== value) decls.push({ property, value });
	return decls;
}

/**
 * The pseudo layers that generate a box at rest, the same test features/pseudo.ts uses. Only
 * these carry a resting rule for a hover override to ride on, so the rest go unmeasured.
 */
function generatingPseudos(el: Element): string[] {
	const out: string[] = [];
	for (const pseudo of ['::before', '::after']) {
		const content = getComputedStyle(el, pseudo).getPropertyValue('content');
		if (content !== '' && content !== 'none' && content !== 'normal') out.push(pseudo);
	}
	return out;
}

/**
 * The measurable computed properties of one layer, as a property to value map. Indexed
 * enumeration is the engine's own stable list, so the read order and the artifact are
 * deterministic. It excludes the timing metadata the shim suppresses, which would read as a
 * spurious change, and custom properties, whose resolved values are measured directly.
 */
function readMeasuredProps(el: Element, pseudo?: string): Map<string, string> {
	const cs = pseudo ? getComputedStyle(el, pseudo) : getComputedStyle(el);
	const props = new Map<string, string>();
	for (let i = 0; i < cs.length; i++) {
		const name = cs[i];
		if (!name || !isMeasurableProperty(name)) continue;
		props.set(name, cs.getPropertyValue(name));
	}
	return props;
}

/** Whether a property belongs in the endpoint diff. See readMeasuredProps for the why. */
function isMeasurableProperty(name: string): boolean {
	if (name.startsWith('--')) return false;
	if (name.startsWith('transition')) return false;
	if (name.startsWith('animation')) return false;
	if (isLogicalAlias(name)) return false;
	return true;
}

/**
 * Whether a property is a logical alias whose physical equivalent getComputedStyle enumerates
 * with the same value, such as `inline-size` against `width`. The physical form is always
 * co-measured, so reading the alias too would emit the same change twice. The snip's writing
 * mode is frozen, so the physical form stands in faithfully.
 */
function isLogicalAlias(name: string): boolean {
	return (
		name === 'inline-size' ||
		name === 'block-size' ||
		name.includes('-inline-') ||
		name.includes('-block-') ||
		name.endsWith('-inline') ||
		name.endsWith('-block')
	);
}

/** Normalizes a bearer's pseudos to a canonical, deduplicated, sorted list for stable keying. */
function canonicalPseudos(pseudos: string[]): string[] {
	return [...new Set(pseudos.map((p) => p.toLowerCase()))].sort();
}

/** Tags each trigger with a unique attribute so the background resolves exactly one node. */
function tagTriggers(triggers: Element[]): Map<Element, string> {
	const tags = new Map<Element, string>();
	let n = 0;
	for (const el of triggers) {
		const token = `f${n++}`;
		el.setAttribute(FORCE_TAG, token);
		tags.set(el, token);
	}
	return tags;
}

/** Installs the transitions-off/animations-off shim, returning the node to remove after. */
function installShim(): HTMLStyleElement {
	const style = document.createElement('style');
	style.setAttribute(FORCE_TAG, 'shim');
	style.textContent = SHIM_TEXT;
	document.head.appendChild(style);
	return style;
}

/** Begins the host force session. Returns false if cdp is unavailable, a soft-fail. */
async function beginForce(): Promise<boolean> {
	try {
		const res = await getHost().forceBegin();
		return !!res?.ok;
	} catch {
		return false;
	}
}

/** Forces a pseudo-state set on one node, or clears it with an empty list. Returns false if not found. */
async function forceState(selector: string, states: string[]): Promise<boolean> {
	try {
		const res = await getHost().forceState(selector, states);
		return !!res?.ok && res.result?.found !== false;
	} catch {
		return false;
	}
}

/** Ends the host force session: clears emulated media + detaches. Best-effort. */
async function endForce(): Promise<void> {
	await getHost().forceEnd().catch(() => {});
}

