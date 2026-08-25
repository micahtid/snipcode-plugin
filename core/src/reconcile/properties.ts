/**
 * reconcile/properties.ts: reading the document's @property registrations.
 *
 * A registration carries a syntax, an inherits flag, and often an initial-value, which govern
 * how the property falls back and interpolates. features/layers.ts re-emits the rules so the
 * artifact keeps that behavior. resolve/vars.ts treats a registration with an initial-value as
 * resolvable, since var() yields it even when nothing sets the property.
 *
 * CSSPropertyRule is missing from some dom lib versions, so a rule is detected structurally by
 * its descriptor fields.
 */

import { holdsChildRules, readableRuleLists } from '../utils/css-rules';

/** One registered @property: its name, its initial-value or null when none, and its source text. */
export interface RegisteredProperty {
	/** The custom-property name, including the leading `--`. */
	name: string;
	/** The registered initial-value, or null when the registration declares none. */
	initialValue: string | null;
	/** The rule's serialized text, for re-emission. */
	cssText: string;
}

/** Every `@property` registration in the document, keyed by name. Unreadable sheets skip. */
export function registeredProperties(): Map<string, RegisteredProperty> {
	const out = new Map<string, RegisteredProperty>();
	for (const rules of readableRuleLists()) collect(rules, out);
	return out;
}

/** Recursively collect @property registrations (CSSPropertyRule), detected structurally. */
function collect(rules: CSSRuleList, out: Map<string, RegisteredProperty>): void {
	for (const rule of Array.from(rules)) {
		const r = rule as unknown as { name?: unknown; syntax?: unknown; inherits?: unknown; initialValue?: unknown; cssText?: string };
		if (typeof r.name === 'string' && typeof r.syntax === 'string' && r.name.startsWith('--')) {
			const initialValue = typeof r.initialValue === 'string' && r.initialValue !== '' ? r.initialValue : null;
			out.set(r.name, { name: r.name, initialValue, cssText: r.cssText ?? serialize(r, initialValue) });
		} else if (holdsChildRules(rule)) {
			collect(rule.cssRules, out);
		}
	}
}

/** Fallback serializer for an @property rule when cssText is unavailable. */
function serialize(r: { name?: unknown; syntax?: unknown; inherits?: unknown }, initialValue: string | null): string {
	const initial = initialValue ? `\n\tinitial-value: ${initialValue};` : '';
	return `@property ${String(r.name)} {\n\tsyntax: ${String(r.syntax)};\n\tinherits: ${String(r.inherits)};${initial}\n}`;
}
