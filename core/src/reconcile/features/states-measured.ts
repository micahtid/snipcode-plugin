/**
 * features/states-measured.ts: emitting the states the capture phase measured live
 *
 * Pipeline position: reconcile, the preferred half of features/states.ts
 * Reads from Captured: root, clone, bakedStyles
 * Writes to Captured: clone, marking elements and appending state rules, and warnings
 *
 * Why this exists: when capture/states-measure.ts forced each state and read what actually
 * computed, the engine has already resolved the cascade, the inheritance, and every
 * group-hover, descendant, and sibling relationship. Nothing is left to parse, so this path
 * only has to map the measurement back onto clone elements, key it to markers, and shed the
 * declarations that restate the resting value. That is why it is preferred over the copied
 * path in features/states-copied.ts, which has to infer all of it from selectors.
 */
import type { Captured, MeasuredState, MeasuredStateDecl } from '../../types';
import { pairedSubtrees } from '../match';
import { appendSynthesizedRules } from '../synthesized';
import { splitTopLevel } from '../../utils/css-split';
import { generalize, MARKER } from './states-anchor';

/**
 * Emits the measured states. Each is already a list of concrete computed deltas keyed to the
 * original elements and their generating pseudo layers. So this maps those to clones, marks
 * them, builds the marker selector with a safe generalized combinator and the layer's
 * pseudo-element, denoises against the resting baseline, and emits the rest !important. A pinned
 * endpoint also gets a coherent transition re-emitted on the element's resting rule, so it
 * animates in both directions rather than snapping on the way out. No cascade merge and no var()
 * survival remain, because the engine resolved both when the value was measured.
 *
 * @param captured - clone is mutated in place: markers and an appended <style>
 * @param measuredStates - the computed deltas per trigger and state from capture/states-measure.ts
 */
export function applyMeasured(captured: Captured, measuredStates: MeasuredState[]): Captured {
	if (measuredStates.length === 0) return captured;
	const pairs = pairedSubtrees(captured.root, captured.clone);
	const originalToClone = new Map<Element, Element>(pairs.map(([original, clone]) => [original, clone]));

	// Resolve each measured trigger, state, and affected-element triple to clone elements. An
	// element a later feature handler did not carry into the clone is skipped, since it cannot
	// be re-anchored.
	const units = resolveMeasuredUnits(measuredStates, originalToClone);
	if (units.length === 0) return captured;

	// Number every marked element by clone document order, so markers and the rules keying them
	// are deterministic regardless of the order states were measured in.
	const markerIds = assignMeasuredMarkers(pairs, units);
	for (const [el, id] of markerIds) el.setAttribute(MARKER, String(id));

	// Group declarations by the selector they re-anchor to. Distinct trigger, state, and affected
	// triples produce distinct marker selectors, so a group is normally one triple. The merge is
	// just the natural home for its denoised declarations.
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
		// A pseudo layer is denoised against its own resting pseudo, already shed at capture by the
		// per-pseudo diff, not the element's baked map, which describes a different box. The element
		// box keeps its baked-value baseline.
		const resting = unit.pseudoElement ? undefined : captured.bakedStyles.get(unit.affectedClone);
		denoiseMeasured(unit.decls, resting, winners);
		groups.set(selector, winners);
		// Collect the element box's pinned props. A coherent transition over them is emitted on the
		// resting rule below. Pseudo layers are excluded, because a pseudo's own resting transition,
		// shipped on its pseudo rule, already governs its fade in both directions.
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
	// Re-emit a coherent transition on each affected element's resting rule, not its state rule, so
	// the pinned endpoints animate when both entering and leaving the state. A transition lives on
	// the base rule by spec. The engine reads timing from the after-change style, which is the
	// hovered state on the way in and the resting state on the way out, so a transition placed only
	// on the :hover rule animates the entry and snaps the exit. The base rule governs both. This is
	// render-neutral, since a transition produces no pixels at rest, so the resting render is
	// unchanged.
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
 *
 * @param measuredStates - the measured deltas keyed to original elements
 * @param originalToClone - the original->clone map from pairedSubtrees
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
 *
 * @param pairs - the [original, clone] subtree pairs, in document order
 * @param units - the resolved emit units
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
 * Builds the output selector for one unit. It is the trigger marker carrying its state pseudos,
 * then, when the affected element is not the trigger itself, the generalized combinator and the
 * affected marker. The affected layer's pseudo-element, if any, is appended to the subject, as in
 * `[marker]:hover::after` when the trigger is the subject, or `[trigger]:hover [affected]::after`
 * for a descendant. Returns null when the relationship is not expressible by a single combinator.
 *
 * @param unit - the emit unit
 * @param markerIds - the assigned marker id per clone element
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
 * Color-family properties that resolve to `currentColor` when not pinned to a divergent value.
 * This happens either by css default (border, outline, decoration, emphasis, caret, column-rule,
 * and text-stroke) or because reconcile/features/colors.ts normalized an icon's matching literal
 * back to it (fill and stroke). A measured change to one of these that equals the forced `color`
 * is carried by the `color` declaration we already emit. A color pinned to its own divergent
 * value would not have tracked `color` into the diff in the first place, so dropping it is sound.
 * `color` itself, the source, and `-webkit-text-fill-color`, the one channel the resting bake
 * pins per element and so severs the inheritance a text recolor rides, are never dropped this way.
 */
const CURRENT_COLOR_TRACKERS = new Set([
	'caret-color', 'outline-color', 'text-decoration-color', 'text-emphasis-color', 'column-rule-color',
	'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
	'-webkit-text-stroke-color', 'fill', 'stroke',
]);

/** Box-size properties whose css initial value is `auto`, so an unset resting base is `auto`. */
const AUTO_SIZED_PROPS = new Set(['width', 'height', 'inline-size', 'block-size']);

/**
 * Whether a measured property's resting base resolves to `auto`, and so cannot interpolate to
 * the concrete length measured in the state. A transition animates between two values only when
 * both are interpolable. `auto` is not, so a size pinned onto the state over an `auto` base can
 * only snap while every concrete-valued neighbour eases. An `auto`-sized box is content-driven,
 * and the content deltas that grow it are pinned in their own right, so left unpinned it resizes
 * standalone exactly as the live element does when its own `auto` box flows. The base is read as
 * `auto` from the resting bake, or inferred for a size property the bake left unset since its
 * initial value is `auto`. A base already pinned to a concrete length stays pinned and animates.
 *
 * @param property - the measured longhand
 * @param resting - the affected element's resting baked value for it, or undefined when unset
 */
function baseIsAuto(property: string, resting: string | undefined): boolean {
	if (resting !== undefined) return resting.trim() === 'auto';
	return AUTO_SIZED_PROPS.has(property);
}

/**
 * Folds a unit's measured declarations into a selector's winners, dropping any that merely
 * restate the element's resting baked value, cannot animate from an `auto` base, have no effect
 * in this element's context, or only track the forced `color`, so the emitted rule stays
 * proportional to the real change. A later unit for the same selector overwrites an earlier
 * property, but distinct triples carry distinct selectors, so this is just the per-selector
 * accumulation point.
 *
 * @param decls - the measured declarations for this affected element
 * @param resting - the affected clone's resting baked styles
 * @param winners - the per-property winners for the selector, mutated in place
 */
function denoiseMeasured(decls: MeasuredStateDecl[], resting: Map<string, string> | undefined, winners: Map<string, string>): void {
	const present = (prop: string): boolean => {
		const value = decls.find((d) => d.property === prop)?.value ?? resting?.get(prop);
		return value !== undefined && value !== '' && value !== 'none';
	};
	// transform-origin/perspective-origin resolve to per-element pixels, so a size change shifts
	// them, but they only have an effect on a box that actually establishes a transform/perspective.
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
 * The transition to broaden onto an affected element's resting rule so its pinned endpoints
 * animate coherently in both directions, or null when none is needed. It reads the element's
 * resting transition live from the original. The measurement shim suppressed it, so it is only
 * readable here, at emit, with the page at rest. Returns null when the element has no real resting
 * transition, since the live element snaps too and adding motion would be wrong, or when the
 * resting transition already covers every changed property, in which case the resting baked
 * transition shipped at rest governs the animation and re-emitting would be redundant. Otherwise
 * it broadens to `all` with the element's longest-running timing, so a property the resting
 * transition does not cover, such as the dot's colors-only timing vs our pinned width, animates
 * in step rather than snapping. This is the deliberate approximation: coordinated motion at the
 * element's rhythm, not exact per-property timing.
 *
 * @param original - the affected live element, read at rest
 * @param changed - the property names the state rules pin on the element
 */
function broadenedTransition(original: Element, changed: Set<string>): string | null {
	const cs = getComputedStyle(original);
	const properties = splitCommas(cs.getPropertyValue('transition-property'));
	const durations = splitCommas(cs.getPropertyValue('transition-duration'));
	const timings = splitCommas(cs.getPropertyValue('transition-timing-function'));
	const delays = splitCommas(cs.getPropertyValue('transition-delay'));
	// Pair each transitioned property with its timing, repeating the shorter lists as the cascade
	// does. Keep only the ones that actually animate (a real, positive duration).
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
 * Splits a comma list at top level, so a `cubic-bezier(..., ...)` timing function stays one
 * entry. Interior empty entries are kept, since these lists are read positionally against a
 * sibling list, but a trailing empty one, which a trailing comma leaves behind, is dropped.
 */
function splitCommas(value: string): string[] {
	const parts = splitTopLevel(value, ',').map((part) => part.trim());
	if (parts[parts.length - 1] === '') parts.pop();
	return parts;
}
