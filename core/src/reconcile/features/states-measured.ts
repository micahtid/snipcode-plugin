/**
 * features/states-measured.ts: emitting the states capture measured live.
 *
 * The preferred half of features/states.ts. Because capture/states-measure.ts forced each
 * state and read what computed, the engine already resolved the cascade, the inheritance, and
 * every group-hover, descendant, and sibling relationship. Nothing is left to parse, so this
 * only maps the measurement back onto clone elements, keys it to markers, and sheds the
 * declarations that restate the resting value.
 */
import type { Captured, MeasuredState, MeasuredStateDecl } from '../../types';
import { pairedSubtrees } from '../match';
import { appendSynthesizedRules } from '../synthesized';
import { splitTopLevel } from '../../utils/css-split';
import { generalize, MARKER } from './states-anchor';

/**
 * Emits the measured states. Each is already a list of concrete computed deltas keyed to the
 * original elements and their pseudo layers. So this maps them to clones, marks them, builds
 * the marker selector, denoises against the resting baseline, and emits the rest !important.
 * A pinned endpoint also gets a coherent transition on the element's resting rule, so it
 * animates in both directions rather than snapping on the way out.
 *
 * @param captured - clone is mutated in place: markers and an appended <style>
 */
export function applyMeasured(captured: Captured, measuredStates: MeasuredState[]): Captured {
	if (measuredStates.length === 0) return captured;
	const pairs = pairedSubtrees(captured.root, captured.clone);
	const originalToClone = new Map<Element, Element>(pairs.map(([original, clone]) => [original, clone]));

	// Resolve each measured triple to clone elements. One a later handler did not carry into
	// the clone is skipped, since it cannot be re-anchored.
	const units = resolveMeasuredUnits(measuredStates, originalToClone);
	if (units.length === 0) return captured;

	// Number marked elements by clone document order, so markers stay deterministic whatever
	// order the states were measured in.
	const markerIds = assignMeasuredMarkers(pairs, units);
	for (const [el, id] of markerIds) el.setAttribute(MARKER, String(id));

	// Group declarations by the selector they re-anchor to. Distinct triples produce distinct
	// marker selectors, so a group is normally one triple.
	const groups = new Map<string, Map<string, string>>();
	// The element-box props each affected clone pins across all its states, plus its live original,
	// so one coherent resting transition can be emitted per element below.
	const pinned = new Map<Element, { original: Element; props: Set<string> }>();
	for (const unit of units) {
		const selector = buildMeasuredSelector(unit, markerIds);
		if (!selector) {
			captured.warnings.push(`states: could not anchor a measured ${unit.states.join('')} effect standalone; dropped`);
			continue;
		}
		const winners = groups.get(selector) ?? new Map<string, string>();
		// A pseudo layer denoises against its own resting pseudo, already shed at capture, not
		// against the element's baked map, which describes a different box.
		const resting = unit.pseudoElement ? undefined : captured.bakedStyles.get(unit.affectedClone);
		denoiseMeasured(unit.decls, resting, winners);
		groups.set(selector, winners);
		// The element box's pinned props, for the coherent transition emitted below. Pseudo
		// layers are excluded: their own resting transition already governs the fade.
		if (!unit.pseudoElement) {
			const entry = pinned.get(unit.affectedClone) ?? { original: unit.affectedOriginal, props: new Set<string>() };
			for (const prop of winners.keys()) entry.props.add(prop);
			pinned.set(unit.affectedClone, entry);
		}
	}

	const rules: string[] = [];
	for (const [selector, winners] of groups) {
		const lines = [...winners].map(([prop, value]) => `\t${prop}: ${value} !important;`);
		if (lines.length > 0) rules.push(`${selector} {\n${lines.join('\n')}\n}`);
	}
	// The coherent transition goes on the resting rule, not the state rule, so the pinned
	// endpoints animate both entering and leaving. The engine reads timing from the
	// after-change style, so a transition only on the :hover rule eases the entry and snaps
	// the exit. Render-neutral, since a transition paints nothing at rest.
	for (const [clone, { original, props }] of pinned) {
		const id = markerIds.get(clone);
		if (id === undefined || props.size === 0) continue;
		const transition = broadenedTransition(original, props);
		if (transition) rules.push(`[${MARKER}="${id}"] {\n\ttransition: ${transition} !important;\n}`);
	}
	appendSynthesizedRules(captured, rules);
	return captured;
}

/** One emit unit: a trigger clone forced into `states`, and one affected clone layer's measured delta. */
interface MeasuredUnit {
	triggerClone: Element;
	states: string[];
	affectedClone: Element;
	/** The affected layer: '' for the element box, '::after'/'::before' for a generated box. */
	pseudoElement: string;
	/** The affected original element, for reading its resting transition live at emit time. */
	affectedOriginal: Element;
	decls: MeasuredStateDecl[];
}

/**
 * Maps each measured trigger, state, and affected triple to its clone counterparts, dropping a
 * triple whose trigger or affected element is absent from the clone.
 */
function resolveMeasuredUnits(measuredStates: MeasuredState[], originalToClone: Map<Element, Element>): MeasuredUnit[] {
	const units: MeasuredUnit[] = [];
	for (const ms of measuredStates) {
		const triggerClone = originalToClone.get(ms.trigger);
		if (!triggerClone) continue;
		for (const affected of ms.affected) {
			const affectedClone = originalToClone.get(affected.element);
			if (!affectedClone) continue;
			units.push({
				triggerClone,
				states: ms.states,
				affectedClone,
				pseudoElement: affected.pseudoElement ?? '',
				affectedOriginal: affected.element,
				decls: affected.decls,
			});
		}
	}
	return units;
}

/**
 * Assigns a marker id to every clone element a unit references, trigger or affected, numbered
 * by document order for determinism.
 */
function assignMeasuredMarkers(pairs: Array<[Element, Element]>, units: MeasuredUnit[]): Map<Element, number> {
	const needed = new Set<Element>();
	for (const unit of units) {
		needed.add(unit.triggerClone);
		needed.add(unit.affectedClone);
	}
	const ids = new Map<Element, number>();
	let next = 0;
	for (const [, clone] of pairs) if (needed.has(clone) && !ids.has(clone)) ids.set(clone, next++);
	return ids;
}

/**
 * The output selector for one unit. It is the trigger marker with its state pseudos, then,
 * when the affected element is not the trigger, the generalized combinator and the affected
 * marker. The layer's pseudo-element is appended to the subject, giving `[marker]:hover::after`
 * or `[trigger]:hover [affected]::after`. Null when no single combinator expresses the relation.
 */
function buildMeasuredSelector(unit: MeasuredUnit, markerIds: Map<Element, number>): string | null {
	const triggerId = markerIds.get(unit.triggerClone);
	const affectedId = markerIds.get(unit.affectedClone);
	if (triggerId === undefined || affectedId === undefined) return null;
	const triggerPart = `[${MARKER}="${triggerId}"]${unit.states.join('')}`;
	if (unit.triggerClone === unit.affectedClone) return `${triggerPart}${unit.pseudoElement}`;
	const combinator = generalize(unit.triggerClone, unit.affectedClone);
	if (!combinator) return null;
	const affectedPart = `[${MARKER}="${affectedId}"]${unit.pseudoElement}`;
	return combinator === ' ' ? `${triggerPart} ${affectedPart}` : `${triggerPart} ${combinator} ${affectedPart}`;
}

/**
 * Color-family properties that resolve to `currentColor` unless pinned elsewhere, either by css
 * default or because features/colors.ts normalized an icon's literal back to it. A measured
 * change equal to the forced `color` is already carried by the `color` declaration. One pinned
 * to its own value would not have tracked `color` into the diff at all.
 *
 * Two are never dropped this way: `color` itself, the source, and `-webkit-text-fill-color`,
 * the channel the resting bake pins per element, which severs the inheritance a recolor rides.
 */
const CURRENT_COLOR_TRACKERS = new Set([
	'caret-color', 'outline-color', 'text-decoration-color', 'text-emphasis-color', 'column-rule-color',
	'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
	'-webkit-text-stroke-color', 'fill', 'stroke',
]);

/** Box-size properties whose css initial value is `auto`, so an unset resting base is `auto`. */
const AUTO_SIZED_PROPS = new Set(['width', 'height', 'inline-size', 'block-size']);

/**
 * Whether a property's resting base is `auto`, which cannot interpolate to the concrete length
 * measured in the state. Pinned over such a base, a size can only snap while its neighbours
 * ease. An `auto` box is content-driven, and the content deltas that grow it are pinned in
 * their own right. Left unpinned it resizes exactly as the live element does.
 *
 * The base reads `auto` from the resting bake, or is inferred for a size property the bake
 * left unset, since its initial value is `auto`. A base already pinned to a length animates.
 *
 * @param resting - the affected element's resting baked value for it, or undefined when unset
 */
function baseIsAuto(property: string, resting: string | undefined): boolean {
	if (resting !== undefined) return resting.trim() === 'auto';
	return AUTO_SIZED_PROPS.has(property);
}

/**
 * Folds a unit's declarations into a selector's winners. Four kinds drop along the way. Those
 * that restate the resting baked value, cannot animate from an `auto` base, do nothing in this
 * element's context, or only track the forced `color`. What is left matches the real change.
 *
 * @param winners - the per-property winners for the selector, mutated in place
 */
function denoiseMeasured(decls: MeasuredStateDecl[], resting: Map<string, string> | undefined, winners: Map<string, string>): void {
	const present = (prop: string): boolean => {
		const value = decls.find((d) => d.property === prop)?.value ?? resting?.get(prop);
		return value !== undefined && value !== '' && value !== 'none';
	};
	// The origin properties shift with any size change, but act only on a box that establishes
	// a transform or perspective.
	const hasTransform = present('transform') || present('translate') || present('rotate') || present('scale');
	const hasPerspective = present('perspective');
	const forcedColor = decls.find((d) => d.property === 'color')?.value;

	for (const decl of decls) {
		const rest = resting?.get(decl.property);
		if (rest !== undefined && rest.trim() === decl.value.trim()) continue;
		if (baseIsAuto(decl.property, rest)) continue; // Auto base cannot interpolate, so leave it content-driven.
		if (decl.property === 'transform-origin' && !hasTransform) continue;
		if (decl.property === 'perspective-origin' && !hasTransform && !hasPerspective) continue;
		if (forcedColor !== undefined && CURRENT_COLOR_TRACKERS.has(decl.property) && decl.value.trim() === forcedColor.trim()) continue;
		winners.set(decl.property, decl.value);
	}
}

/**
 * The transition to broaden onto an element's resting rule so its pinned endpoints animate in
 * both directions, or null when none is needed. The element's resting transition is read live
 * from the original, since the measurement shim suppressed it and only emit time, with the
 * page at rest, can see it.
 *
 * Null when the element has no real resting transition, because the live element snaps too, or
 * when the resting one already covers every changed property. Otherwise it broadens to `all`
 * at the element's longest timing, so a property the resting transition misses animates in
 * step. A deliberate approximation: coordinated motion at the element's rhythm, not exact
 * per-property timing.
 */
function broadenedTransition(original: Element, changed: Set<string>): string | null {
	const cs = getComputedStyle(original);
	const properties = splitCommas(cs.getPropertyValue('transition-property'));
	const durations = splitCommas(cs.getPropertyValue('transition-duration'));
	const timings = splitCommas(cs.getPropertyValue('transition-timing-function'));
	const delays = splitCommas(cs.getPropertyValue('transition-delay'));
	// Pair each property with its timing, cycling the shorter lists as the cascade does, and
	// keep only the ones that actually animate.
	const entries = properties
		.map((property, i) => ({
			property,
			duration: durations[i % durations.length] ?? '0s',
			timing: timings[i % timings.length] ?? 'ease',
			delay: delays[i % delays.length] ?? '0s',
		}))
		.filter((e) => e.property !== 'none' && durationSeconds(e.duration) > 0);
	if (entries.length === 0) return null;
	const coversAll = entries.some((e) => e.property === 'all');
	const covered = (prop: string): boolean => coversAll || entries.some((e) => e.property === prop);
	if ([...changed].every(covered)) return null;
	const rep = entries.reduce((a, b) => (durationSeconds(b.duration) > durationSeconds(a.duration) ? b : a));
	return `all ${rep.duration} ${rep.timing} ${rep.delay}`;
}

/** Seconds for a CSS <time> (`0.3s`, `300ms`, `0s`), or 0 for anything unparseable. */
function durationSeconds(value: string): number {
	const v = value.trim();
	if (v.endsWith('ms')) return parseFloat(v) / 1000 || 0;
	if (v.endsWith('s')) return parseFloat(v) || 0;
	return parseFloat(v) || 0;
}

/**
 * Splits a comma list at top level, so a `cubic-bezier(..., ...)` stays one entry. Interior
 * empties are kept, since these lists are read positionally against a sibling list, but a
 * trailing one, left by a trailing comma, is dropped.
 */
function splitCommas(value: string): string[] {
	const parts = splitTopLevel(value, ',').map((part) => part.trim());
	if (parts[parts.length - 1] === '') parts.pop();
	return parts;
}
