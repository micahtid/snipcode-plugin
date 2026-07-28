/**
 * features/units.ts: resolving units that would mean something else elsewhere.
 *
 * A viewport or container length resolves against the viewport or containment context, which
 * changes when the snip is reparented: a 50vw hero becomes half of whatever it lands in. Each
 * is replaced with the live element's computed px, which locks the captured pixels without a
 * synthetic wrapper. A wrapper could not work anyway, since the artifact renders at the
 * element's own size and a viewport-sized one would clip.
 *
 * Two related bakes live here. Logical properties survive as authored, but they resolve
 * against direction and writing-mode, so those are baked when non-default. And aspect-ratio
 * plus intrinsic img width and height are baked so the box keeps its ratio standalone.
 */
import type { Captured } from '../../types';
import { pairedSubtrees } from '../match';

// Viewport-percentage and container-query length units, the dynamic ones.
const DYNAMIC_UNIT = /\b\d*\.?\d+(?:vw|vh|vi|vb|vmin|vmax|dvw|dvh|svw|svh|lvw|lvh|cqw|cqh|cqi|cqb|cqmin|cqmax)\b/i;

/**
 * Resolves baked values that use viewport/container units to their captured px.
 *
 * @param captured - bakedStyles + clone are mutated in place
 */
export function apply(captured: Captured): Captured {
	for (const [original, clone] of pairedSubtrees(captured.root, captured.clone)) {
		const baked = captured.bakedStyles.get(clone) ?? new Map<string, string>();
		const computed = getComputedStyle(original);

		// Resolve viewport/container units to captured px.
		for (const [prop, value] of baked) {
			if (!DYNAMIC_UNIT.test(value)) continue;
			const literal = computed.getPropertyValue(prop);
			if (!literal || DYNAMIC_UNIT.test(literal)) continue; // Could not resolve, so leave as-is
			setBaked(clone, baked, prop, literal);
		}

		// Logical properties resolve against direction and writing-mode, so bake them
		// when non-default so rtl and vertical text maps inline and block axes correctly.
		bakeNonDefault(clone, baked, computed, 'direction', (v) => v === '' || v === 'ltr');
		bakeNonDefault(clone, baked, computed, 'writing-mode', (v) => v === '' || v === 'horizontal-tb');

		// Aspect-ratio: bake when explicitly set so the box keeps its ratio.
		bakeNonDefault(clone, baked, computed, 'aspect-ratio', (v) => v === '' || v === 'auto');

		// <img> intrinsic dimensions feed aspect-ratio: auto and prevent layout
		// shift. Copy the natural size to width/height attributes when missing.
		if (original instanceof HTMLImageElement && clone instanceof HTMLImageElement) {
			pinIntrinsicSize(original, clone, baked);
		}

		if (baked.size > 0) captured.bakedStyles.set(clone, baked);
	}
	return captured;
}

/**
 * Copy a loaded image's natural size to width/height attributes, but only when
 * css sizes neither dimension, otherwise attr-derived aspect-ratio could fight
 * the baked css and shift the box.
 */
function pinIntrinsicSize(original: HTMLImageElement, clone: HTMLImageElement, baked: Map<string, string>): void {
	if (original.naturalWidth === 0 || original.naturalHeight === 0) return; // Not loaded
	if (baked.has('width') || baked.has('height')) return; // Css already sizes it
	if (clone.hasAttribute('width') || clone.hasAttribute('height')) return;
	clone.setAttribute('width', String(original.naturalWidth));
	clone.setAttribute('height', String(original.naturalHeight));
}

/** Bake a computed property when a predicate says its value is non-default. */
function bakeNonDefault(
	clone: Element,
	baked: Map<string, string>,
	computed: CSSStyleDeclaration,
	prop: string,
	isDefault: (value: string) => boolean,
): void {
	if (baked.has(prop)) return;
	const value = computed.getPropertyValue(prop);
	if (isDefault(value)) return;
	setBaked(clone, baked, prop, value);
}

/** Record a value in the baked map and on the clone's inline style. */
function setBaked(clone: Element, baked: Map<string, string>, prop: string, value: string): void {
	baked.set(prop, value);
	try {
		(clone as HTMLElement).style.setProperty(prop, value);
	} catch {
		// Invalid for this element, so skip it.
	}
}
