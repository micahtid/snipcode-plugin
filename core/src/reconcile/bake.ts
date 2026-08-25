/**
 * reconcile/bake.ts: baking the winning value of every property onto the clone.
 *
 * Runs first in reconcile. The subtree's styles live in stylesheets that do not travel, so
 * each element gets its own. Per property, the authored value from match.ts ships when it
 * round-trips to the captured computed value on the live element, which preserves var(),
 * clamp(), %, oklch(), and calc(). Otherwise the computed value ships.
 *
 * Two passes act on the root alone. An inherited property diverging from the document default
 * is baked there, since children inherit from the root anyway. Which properties inherit comes
 * from a live parent-child probe, never a table. And a root that was a flex or grid item of a
 * vanished parent gets its resolved geometry baked. It then renders at the same size with no
 * synthetic wrapper.
 *
 * The probe is the whole trick: nothing trusts the matched cascade, every decision is checked
 * against getComputedStyle. That is why this file needs no property tables or per-tag branches.
 */
import type { Captured } from '../types';
import { authoredCascade } from './match';
import { subtreeElements } from './tree';

/**
 * Bakes every element's authored cascade onto the detached clone, into bakedStyles and inline
 * styles, so the clone serializes to standalone html.
 *
 * @param captured - the capture whose clone and bakedStyles are mutated in place
 */
export function reconcile(captured: Captured): void {
	const cascade = authoredCascade(captured);
	const originals = subtreeElements(captured.root);
	const clones = subtreeElements(captured.clone);
	if (originals.length !== clones.length) {
		// Impossible with a cloneNode(true), but if something mutated structure earlier, bail
		// rather than mis-pair styles onto the wrong nodes.
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

	// Both root passes act on index 0 alone: inherited values flow down on their own, and the
	// escaped-layout box belongs to the root.
	const rootOriginal = originals[0];
	const rootClone = clones[0];
	if (rootOriginal && rootClone) {
		bakeRootContext(rootOriginal, rootClone, captured);
	}
}

/** Applies the inherited-divergence and escaped-layout passes to the snip root. */
function bakeRootContext(original: Element, clone: Element, captured: Captured): void {
	const baked = captured.bakedStyles.get(clone) ?? new Map<string, string>();
	bakeInheritedDivergence(original, baked);
	bakeEscapedLayout(original, baked);
	captured.bakedStyles.set(clone, baked);
	writeInline(clone, baked);
}

/**
 * Bakes inherited properties whose value at the root diverges from the document default.
 *
 * A detached probe answers two questions per property: does it inherit, and does the root's
 * value differ from a fresh same-tag element's default? Both yes means the value is lost on
 * reparenting, so it is baked. An authored value already baked wins and is left alone.
 *
 * @param baked - the root's baked map, extended in place
 */
function bakeInheritedDivergence(original: Element, baked: Map<string, string>): void {
	const rootComputed = getComputedStyle(original);
	// What `currentcolor` resolves to here. See the guard in the loop.
	const rootColor = rootComputed.getPropertyValue('color');
	// A same-tag element in a neutral parent gives both the ua defaults and the child probe.
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
			// A value equal to the root's own `color` is resolving from its `currentcolor`
			// initial: caret-color, text-fill-color, and their kin. Freezing it onto the root
			// inherits down and overrides every descendant, so a button setting only a light
			// `color` would keep the root's dark fill. `color` itself is baked in this same
			// pass and carries the real value down, so those track their own color again.
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
 * Dynamic inheritance test: set `value` on the probe parent and see whether the probe child,
 * which declares nothing itself, picks it up. The value is the root's own computed value, so
 * it is always valid for the property and the probe needs no per-property sentinel.
 *
 * @returns true when the property inherits, and so is divergence-prone
 */
function isInherited(parent: HTMLElement, child: Element, prop: string, value: string, defaultVal: string): boolean {
	// The caller only reaches here when value differs from the default, which is what makes
	// the child's pickup observable.
	parent.style.setProperty(prop, value);
	try {
		const childNow = getComputedStyle(child).getPropertyValue(prop);
		return childNow === value && childNow !== defaultVal;
	} finally {
		parent.style.removeProperty(prop);
	}
}

/**
 * When the root was a flex or grid item of a parent outside the snip, its used width and
 * height came from that vanished container. So the resolved geometry is baked and the root
 * keeps its size standalone. No synthetic wrapper. Only width and height, because those are
 * exactly what such a container imposes on its items.
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
 * Runs the authored-versus-computed test over one element's properties.
 *
 * @param original - the live element, which has document context for getComputedStyle
 */
function bakeElement(original: Element, authored: Map<string, string>): Map<string, string> {
	const baked = new Map<string, string>();
	const computedStyle = getComputedStyle(original);
	for (const [prop, authoredValue] of authored) {
		const computed = computedStyle.getPropertyValue(prop);
		// Shorthands and custom properties never appear in computed style, so there is no
		// ground truth to check them against and the authored value is trusted.
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
 * Whether forcing `value` onto the element's inline style reproduces the captured computed
 * value. It runs in the element's real context, so rem, %, and var() resolve correctly. The
 * mutation is undone in the same synchronous frame, so the page never visibly changes.
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

