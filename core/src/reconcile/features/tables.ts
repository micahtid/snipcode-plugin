/**
 * features/tables.ts: table geometry properties.
 *
 * border-collapse, border-spacing, table-layout, caption-side, and empty-cells all change a
 * table's geometry. A class that does not travel usually sets them, so a snipped table loses
 * its collapsed borders or fixed layout. Non-tables compute the defaults and are skipped, so
 * no tag check is needed.
 */
import type { Captured } from '../../types';
import { bakeNonDefaultProps } from '../match';

/** Bakes non-default table rendering properties. bakedStyles + clone mutated in place. */
export function apply(captured: Captured): Captured {
	bakeNonDefaultProps(captured, [
		{ prop: 'table-layout', isDefault: (v) => v === 'auto' },
		{ prop: 'border-collapse', isDefault: (v) => v === 'separate' },
		{ prop: 'border-spacing', isDefault: (v) => v === '0px' || v === '0px 0px' },
		{ prop: 'caption-side', isDefault: (v) => v === 'top' },
		{ prop: 'empty-cells', isDefault: (v) => v === 'show' },
	]);
	return captured;
}
