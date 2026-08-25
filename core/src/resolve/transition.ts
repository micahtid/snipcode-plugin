/**
 * resolve/transition.ts: re-expanding a transition timing list the var pass collapsed.
 *
 * Runs during resolve, after vars. A utility build pairs a many-entry transition-property with
 * a duration authored as one var(), which css cycles across every property. Resolving that var
 * leaves a one-entry timing list. The cssom then folds the shorthand with the timing on the
 * first layer only, so on hover the color eases while everything else snaps.
 *
 * Cycling the shorter list back out is the engine's own rule, so this is render-neutral: it
 * only redistributes timing the author already wrote.
 */
import type { Captured } from '../types';
import { splitCommaList } from '../utils/css-split';

/** The sub-lists css cycles across the property list; padded to its length before folding. */
export const TIMING_LONGHANDS = ['transition-duration', 'transition-timing-function', 'transition-delay', 'transition-behavior'] as const;

/**
 * Pads every clone's transition timing sub-lists out to its `transition-property` length by css
 * cycling, so the later fold into the shorthand keeps each layer's timing. A no-op unless an
 * element has a multi-property transition with a shorter timing list.
 *
 * @param captured - clone + bakedStyles are mutated in place
 */
export function resolveTransitionTiming(captured: Captured): void {
	for (const el of [captured.clone, ...Array.from(captured.clone.querySelectorAll('*'))]) {
		const style = (el as HTMLElement).style;
		if (!style) continue;
		const properties = splitTopLevelCommas(style.getPropertyValue('transition-property'));
		// `all`, `none`, or a single property is one layer, which the cssom never folds lossily.
		if (properties.length < 2) continue;
		const baked = captured.bakedStyles.get(el);
		for (const longhand of TIMING_LONGHANDS) {
			const raw = style.getPropertyValue(longhand);
			if (!raw.trim()) continue; // Longhand absent in this engine, e.g. transition-behavior, so leave it.
			const values = splitTopLevelCommas(raw);
			if (values.length === 0 || values.length >= properties.length) continue; // Already full length.
			const cycled = properties.map((_, i) => values[i % values.length]).join(', ');
			try {
				style.setProperty(longhand, cycled, style.getPropertyPriority(longhand));
			} catch {
				// Invalid for this element, so skip it rather than throw.
			}
			baked?.set(longhand, cycled); // Keep the baked map in step with the inline style.
		}
	}
}

/**
 * Splits on top-level commas only, so a comma inside `cubic-bezier(0.4, 0, 0.2, 1)` stays in
 * its layer. Empty entries drop, matching how the engine reads a transition sub-list.
 */
export function splitTopLevelCommas(value: string): string[] {
	return splitCommaList(value);
}
