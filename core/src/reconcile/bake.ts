/**
 * reconcile/bake.ts: baking the winning value of every property onto the clone.
 *
 * Runs first in reconcile. The subtree's styles live in stylesheets that do not travel, so
 * each element gets its own. Per property: if the authored value from match.ts round-trips to
 * the captured computed value when forced onto the live element, ship the authored string,
 * which preserves var(), clamp(), %, oklch(), and calc(). Otherwise ship the computed value.
 *
 * Two passes act on the root alone. Inherited properties whose value diverges from the
 * document default are baked there, since children inherit from the root anyway; which
 * properties inherit is read from a live parent/child probe, never hardcoded. And a root that
 * was a flex or grid item of a vanished parent gets its resolved geometry baked, so it renders
 * at the same size with no synthetic wrapper.
 *
 * The probe is the whole trick: nothing trusts the matched cascade, every decision is checked
 * against getComputedStyle. That is why this file needs no property tables or per-tag branches.
 */
import type { Captured } from '../types';
import { authoredCascade } from './match';
import { subtreeElements } from './tree';

/**
 * Runs reconcile: bakes every element's authored cascade onto the detached
 * clone, recording the result in bakedStyles and writing inline styles so the
 * clone serializes to standalone html.
 *
 * @param captured - the capture whose clone and bakedStyles are mutated in place
 */
export function reconcile(captured: Captured): void {
	const cascade = authoredCascade(captured);
	const originals = subtreeElements(captured.root);
	const clones = subtreeElements(captured.clone);
	if (originals.length !== clones.length) {
		// Structural divergence should be impossible since the clone is cloneNode(true),
		// but if a feature mutated structure earlier, fail soft and bail rather
		// than mis-pair styles onto the wrong nodes.
		captured.warnings.push('bake: clone/original structure diverged; skipping reconcile');
		return;
	}

	for (let i = 0; i < originals.length; i++) {
		const original = originals[i];
		const clone = clones[i];
		if (!original || !clone) continue;
		const authored = cascade.get(original) ?? new Map<string, string>();
		const baked = bakeElement(original, authored);
		captured.bakedStyles.set(clone, baked);
		writeInline(clone, baked);
	}

	// The inherited-divergence and escaped-layout passes act only on the snip
	// root at index 0. Inherited values flow down to children automatically, and
	// the escaped-layout box belongs to the root.
	const rootOriginal = originals[0];
	const rootClone = clones[0];
	if (rootOriginal && rootClone) {
		bakeRootContext(rootOriginal, rootClone, captured);
	}
}

/**
 * Applies the inherited-divergence and escaped-layout passes to the snip root.
 */
function bakeRootContext(original: Element, clone: Element, captured: Captured): void {
	const baked = captured.bakedStyles.get(clone) ?? new Map<string, string>();
	bakeInheritedDivergence(original, baked); // inherited divergence
	bakeEscapedLayout(original, baked); // escaped layout
	captured.bakedStyles.set(clone, baked);
	writeInline(clone, baked);
}

/**
 * Bakes inherited properties whose computed value at the root diverges from
 * the document default.
 *
 * For each property in the root's computed style, this asks the browser two
 * questions via a detached probe: does the property inherit, and does the root's
 * value differ from a fresh same-tag element's default? If both, the value would
 * be lost when the snip is reparented, so it is baked onto the root. Per-element
 * authored values already baked are left untouched (authored wins).
 *
 * @param baked - the root's baked map, extended in place
 */
function bakeInheritedDivergence(original: Element, baked: Map<string, string>): void {
	const rootComputed = getComputedStyle(original);
	// The value `currentcolor` resolves to on this element. Every color property whose
	// initial value is `currentcolor` follows it unless set (see the guard in the loop).
	const rootColor = rootComputed.getPropertyValue('color');
	// A same-tag element in a neutral parent gives both the ua default values and
	// the child probe for inheritance detection.
	const probeParent = document.createElement('div');
	const probeChild = document.createElement(original.tagName);
	probeParent.appendChild(probeChild);
	// Off-screen but laid out, so getComputedStyle returns real values.
	probeParent.style.cssText = 'position:absolute;left:-99999px;top:-99999px;visibility:hidden';
	document.body.appendChild(probeParent);
	try {
		const childDefault = getComputedStyle(probeChild);
		for (let i = 0; i < rootComputed.length; i++) {
			const prop = rootComputed.item(i);
			if (!prop || baked.has(prop)) continue; // Authored value already won
			const rootVal = rootComputed.getPropertyValue(prop);
			const defaultVal = childDefault.getPropertyValue(prop);
			if (rootVal === defaultVal) continue; // No divergence from default
			// A property whose value merely equals the root's own `color` is resolving from its
			// `currentcolor` initial value: -webkit-text-fill-color, -webkit-text-stroke-color,
			// caret-color, text-emphasis-color, and their kin. Baking it freezes a concrete color
			// onto the root that then inherits down and overrides every descendant, so a button
			// that sets only a light `color` keeps inheriting the root's dark fill and paints dark.
			// The `color` divergence is baked in this same pass and carries the real value to
			// descendants, whose derived colors track their own `color` again. Freezing the
			// color-derived property is therefore both redundant and harmful. `color` itself is
			// excluded so the load-bearing divergence still bakes. A non-color property's value can
			// never equal the color string, so this fires only for currentcolor-derived colors.
			if (prop !== 'color' && rootVal === rootColor) continue;
			if (isInherited(probeParent, probeChild, prop, rootVal, defaultVal)) {
				baked.set(prop, rootVal);
			}
		}
	} finally {
		probeParent.remove();
	}
}

/**
 * Dynamic inheritance test: sets `value` on the probe parent and checks whether
 * the probe child (which has no own declaration for the property) picks it up.
 * The value is the root's own computed value, always a valid css value for the
 * property, so the probe never needs a per-property sentinel.
 *
 * @returns true when the property inherits (and is therefore divergence-prone)
 */
function isInherited(parent: HTMLElement, child: Element, prop: string, value: string, defaultVal: string): boolean {
	// If the root value equals the default we never get here, so value!==default,
	// which makes the child's pickup observable.
	parent.style.setProperty(prop, value);
	try {
		const childNow = getComputedStyle(child).getPropertyValue(prop);
		return childNow === value && childNow !== defaultVal;
	} finally {
		parent.style.removeProperty(prop);
	}
}

/**
 * When the root was a flex/grid item of a parent outside the snip, its used
 * width/height came from that vanished container. Bake the resolved geometry so
 * the root keeps its size standalone. No synthetic wrapper is created.
 *
 * width/height are named explicitly here because they are the specific geometry
 * a flex/grid container imposes on its items. That is a bounded css-spec mechanism
 * rather than a curated heuristic Set, and it applies only when the escaped-context
 * condition holds.
 *
 * @param baked - the root's baked map, extended in place
 */
function bakeEscapedLayout(original: Element, baked: Map<string, string>): void {
	const parent = original.parentElement;
	if (!parent) return;
	const parentDisplay = getComputedStyle(parent).display;
	const escaped = parentDisplay.includes('flex') || parentDisplay.includes('grid');
	if (!escaped) return;
	const computed = getComputedStyle(original);
	// Only lock geometry the author did not already set explicitly.
	for (const prop of ['width', 'height']) {
		if (baked.has(prop)) continue;
		const value = computed.getPropertyValue(prop);
		if (value) baked.set(prop, value);
	}
}

/**
 * Applies the per-element authored-vs-computed test to one element, returning
 * its baked prop->value map.
 *
 * @param original - the live element, which has document context for getComputedStyle
 */
function bakeElement(original: Element, authored: Map<string, string>): Map<string, string> {
	const baked = new Map<string, string>();
	const computedStyle = getComputedStyle(original);
	for (const [prop, authoredValue] of authored) {
		const computed = computedStyle.getPropertyValue(prop);
		// Shorthands and custom props do not appear in computed style. We cannot
		// validate them against ground truth, so trust the authored value.
		if (computed === '') {
			baked.set(prop, authoredValue);
			continue;
		}
		// Ship authored only when it reproduces the captured computed value.
		if (reproducesComputed(original, prop, authoredValue, computed)) {
			baked.set(prop, authoredValue);
		} else {
			baked.set(prop, computed);
		}
	}
	return baked;
}

/**
 * Tests whether forcing `value` onto the element's inline style reproduces the
 * captured computed value, in the element's real context, so rem/%/var resolve
 * correctly. Transiently mutates then restores the live inline style within the
 * same synchronous frame, so the page never visibly changes.
 *
 * @returns true when the authored value round-trips
 */
function reproducesComputed(el: Element, prop: string, value: string, computed: string): boolean {
	const style = (el as HTMLElement).style;
	if (!style) return false;
	const prev = style.getPropertyValue(prop);
	const prevPriority = style.getPropertyPriority(prop);
	try {
		style.setProperty(prop, value);
		return getComputedStyle(el).getPropertyValue(prop) === computed;
	} catch {
		return false;
	} finally {
		if (prev) style.setProperty(prop, prev, prevPriority);
		else style.removeProperty(prop);
	}
}

/** Write a baked prop->value map onto a clone element as inline styles. */
function writeInline(clone: Element, baked: Map<string, string>): void {
	const style = (clone as HTMLElement).style;
	if (!style) return;
	for (const [prop, value] of baked) {
		try {
			style.setProperty(prop, value);
		} catch {
			// Invalid declaration for this element, so skip it rather than throw.
		}
	}
}

