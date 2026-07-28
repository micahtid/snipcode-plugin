/**
 * resolve/transition.ts: re-expanding a transition timing list the var pass collapsed.
 *
 * Runs during resolve, after vars. A utility build sets a many-entry transition-property
 * against a duration and timing function authored as a single var(), which css cycles across
 * every property. Resolving that var to its one literal leaves a one-entry timing list against
 * a many-entry property list, and the cssom then folds the shorthand with the timing on the
 * first layer only, so on hover the color eases while everything else snaps.
 *
 * Cycling the shorter list back out to full length is the engine's own rule, so this is
 * render-neutral. It only redistributes timing the author already wrote.
 */
import type { Captured } from '../types';
import { splitCommaList } from '../utils/css-split';

/** The sub-lists css cycles across the property list; padded to its length before folding. */
export const TIMING_LONGHANDS = ['transition-duration', 'transition-timing-function', 'transition-delay', 'transition-behavior'] as const;

/**
 * Pads every clone element's transition timing sub-lists to its `transition-property` length by
 * css cycling, so the later fold into the `transition` shorthand keeps each layer's timing
 * rather than dropping it onto the first. Mutates the clone inline styles and their baked maps
 * in place. It is a no-op for any element without a genuine multi-property transition whose
 * timing sub-list is shorter than its property list.
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
 * Splits a comma-separated value list on top-level commas only, so a comma inside a function
 * such as `cubic-bezier(0.4, 0, 0.2, 1)` or `steps(4, end)` stays within its layer. Empty
 * entries are dropped, matching how the engine reads a transition sub-list.
 */
export function splitTopLevelCommas(value: string): string[] {
	return splitCommaList(value);
}
