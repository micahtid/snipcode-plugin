/**
 * features/units.ts: resolving units that would mean something else elsewhere.
 *
 * A viewport or container length resolves against a context that changes when the snip is
 * reparented, so a 50vw hero becomes half of whatever it lands in. Each is replaced with the
 * live element's computed px, which locks the captured pixels without a synthetic wrapper. A
 * wrapper could not work anyway: the artifact renders at the element's own size, and a
 * viewport-sized one would clip.
 *
 * Two related bakes live here. Logical properties survive as authored, but they resolve
 * against direction and writing-mode, so those are baked when non-default. And aspect-ratio
 * plus intrinsic img width and height are baked so the box keeps its ratio standalone.
 */
import type { Captured } from '../../types';
import { pairedSubtrees, setBaked } from '../match';

// Viewport-percentage and container-query length units, the dynamic ones.
const DYNAMIC_UNIT = /\b\d*\.?\d+(?:vw|vh|vi|vb|vmin|vmax|dvw|dvh|svw|svh|lvw|lvh|cqw|cqh|cqi|cqb|cqmin|cqmax)\b/i;

/** Resolves viewport and container units to captured px. bakedStyles + clone mutate in place. */
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

		// Logical properties resolve against these two, so rtl and vertical text need them
		// baked to map the inline and block axes correctly.
		bakeNonDefault(clone, baked, computed, 'direction', (v) => v === '' || v === 'ltr');
		bakeNonDefault(clone, baked, computed, 'writing-mode', (v) => v === '' || v === 'horizontal-tb');
		bakeNonDefault(clone, baked, computed, 'aspect-ratio', (v) => v === '' || v === 'auto');

		// An img's intrinsic dimensions feed `aspect-ratio: auto` and stop layout shift.
		if (original instanceof HTMLImageElement && clone instanceof HTMLImageElement) {
			pinIntrinsicSize(original, clone, baked);
		}

		if (baked.size > 0) captured.bakedStyles.set(clone, baked);
	}
	return captured;
}

/**
 * Copies a loaded image's natural size to width/height attributes, but only when css sizes
 * neither dimension: otherwise the attribute-derived ratio fights the baked css and shifts.
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
