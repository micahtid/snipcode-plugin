/**
 * features/fonts.ts: variable-font axes, opentype features, and text metrics.
 *
 * Variable-font settings and opentype features usually arrive from a font's own @font-face or
 * a shorthand rather than as per-element declarations, so the per-element pass never bakes
 * them and the snip reverts to the wrong weight or width with lost ligatures.
 *
 * The text micro-features here (text-overflow, text-decoration-skip-ink, word-break,
 * overflow-wrap, hyphens, text-wrap, white-space-collapse) change where lines break and what
 * truncates, so baking them keeps the captured text layout. writing-mode lives in
 * features/units.ts with the logical properties it governs.
 */
import type { Captured } from '../../types';
import { bakeNonDefaultProps } from '../match';

/**
 * The font and text properties this handler preserves. This is the bounded css-spec
 * surface for variable and opentype fonts and text layout, a feature-handler spec
 * set rather than a hardcoded property list.
 */
const FONT_AND_TEXT_PROPS = [
	// Variable + opentype font metrics.
	{ prop: 'font-variation-settings', isDefault: (v: string) => v === 'normal' },
	{ prop: 'font-feature-settings', isDefault: (v: string) => v === 'normal' },
	{ prop: 'font-optical-sizing', isDefault: (v: string) => v === 'auto' || v === 'normal' },
	{ prop: 'font-stretch', isDefault: (v: string) => v === '100%' || v === 'normal' },
	// Text micro-features.
	{ prop: 'text-overflow', isDefault: (v: string) => v === 'clip' },
	{ prop: 'text-decoration-skip-ink', isDefault: (v: string) => v === 'auto' },
	{ prop: 'word-break', isDefault: (v: string) => v === 'normal' },
	{ prop: 'overflow-wrap', isDefault: (v: string) => v === 'normal' },
	{ prop: 'hyphens', isDefault: (v: string) => v === 'manual' },
	{ prop: 'text-wrap', isDefault: (v: string) => v === 'wrap' || v === 'auto' },
	{ prop: 'white-space-collapse', isDefault: (v: string) => v === 'collapse' },
];

/**
 * Bakes non-default font-metric and text-layout settings onto each element.
 *
 * @param captured - bakedStyles + clone are mutated in place
 */
export function apply(captured: Captured): Captured {
	bakeNonDefaultProps(captured, FONT_AND_TEXT_PROPS);
	return captured;
}
