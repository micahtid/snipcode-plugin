/**
 * inspect/schema/shared.ts: the walked-element record and the helpers every schema pass uses
 *
 * Pipeline position: inspect, page-scoped. See inspect/schema/extract.ts for the whole pass.
 * Reads from DOM: window, for the computed styles the callers hand in.
 * Writes to: nothing.
 *
 * Why this exists: the schema extractor is split across a walk, a token pass, a structure
 * pass, a section pass, and a blueprint pass. A handful of small definitions are needed by
 * more than one of them, chiefly the record the walk produces and the paint and grouping
 * helpers. They live here so no pass imports another just to borrow a helper, which is what
 * would put a cycle in the graph.
 */
import type { SemanticRole } from './classify';
import { classNameOf } from './classify';

/** One element captured by the walk, with its role, fingerprint, and tree position. */
export interface WalkedElement {
	element: Element;
	tag: string;
	role: SemanticRole;
	fingerprint: string;
	properties: Record<string, string>;
	parent: Element | null;
	depth: number;
	pseudoColors?: string[];
	repeat?: number; // Collapsed identical-sibling count, filled during dedup.
}

/** A button element or a link styled as a button. This is shared across the button-detection passes. */
export const BUTTON_SELECTOR = 'button, a[class*="btn"], a[class*="button"]';

/** Whether a normalized color value is fully transparent, painting nothing. */
export function isTransparentColor(value: string): boolean {
	return value === 'transparent' || value === 'rgba(0, 0, 0, 0)';
}

/** Normalizes a paint value to hex when opaque, keeps rgba when translucent, null if absent. */
export function normalizeColor(value: string): string | null {
	if (isTransparentColor(value)) return null;
	const rgbMatch = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
	if (rgbMatch) {
		const [, r, g, b, a] = rgbMatch;
		if (a !== undefined && parseFloat(a) < 1) return value;
		return '#' + [r, g, b].map((c) => parseInt(c!).toString(16).padStart(2, '0')).join('');
	}
	return value;
}

/** The four-side padding shorthand read off a computed style. */
export function paddingShorthand(computed: CSSStyleDeclaration): string {
	return `${computed.paddingTop} ${computed.paddingRight} ${computed.paddingBottom} ${computed.paddingLeft}`;
}

/** Groups items by a string key, preserving insertion order within each group. */
export function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const key = keyOf(item);
		const group = groups.get(key) || [];
		group.push(item);
		groups.set(key, group);
	}
	return groups;
}

/** True when an anchor is styled like a button, with btn/button/cta in its class list. */
export function isButtonLike(el: Element): boolean {
	return /btn|button|cta/.test(classNameOf(el));
}
