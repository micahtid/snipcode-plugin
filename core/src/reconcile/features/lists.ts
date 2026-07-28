/**
 * features/lists.ts: list and counter properties.
 *
 * Custom bullet glyphs, bullet images, and counters all render through ::marker, and are set
 * on the list by a class that does not travel, so a snipped list reverts to plain discs or
 * numbers. list-style-image urls arrive already absolute from getComputedStyle.
 * features/pseudo.ts emits the ::marker rule that consumes the counters.
 */
import type { Captured } from '../../types';
import { bakeNonDefaultProps } from '../match';

/**
 * Bakes non-default list-style and counter properties.
 *
 * @param captured - bakedStyles + clone mutated in place
 */
export function apply(captured: Captured): Captured {
	bakeNonDefaultProps(captured, [
		{ prop: 'list-style-type', isDefault: (v) => v === 'disc' || v === 'decimal' || v === 'none' },
		{ prop: 'list-style-image', isDefault: (v) => v === 'none' },
		{ prop: 'list-style-position', isDefault: (v) => v === 'outside' },
		{ prop: 'counter-reset', isDefault: (v) => v === 'none' },
		{ prop: 'counter-increment', isDefault: (v) => v === 'none' },
	]);
	return captured;
}
