/**
 * features/layers.ts: re-emitting the @property registrations the snip uses.
 *
 * @layer order and @scope need nothing: match.ts builds the cascade and bake.ts validates
 * every value against the computed result, which the browser produced with layer and scope
 * precedence already applied.
 *
 * @property is the part that does not survive. A registration carries the syntax, inherits
 * flag, and initial-value that govern how a custom property falls back and interpolates, such
 * as an animated --angle gradient. Only the registration is re-emitted, never a synthetic
 * layer order.
 */
import type { Captured } from '../../types';
import { registeredProperties } from '../properties';
import { forEachSynthesizedDeclaration } from '../synthesized';

const VAR_REF = /var\(\s*(--[A-Za-z0-9_-]+)/g;

/**
 * Re-emits @property registrations for custom properties the snip uses.
 *
 * @param captured - clone is mutated in place
 */
export function apply(captured: Captured): Captured {
	const used = usedCustomProps(captured);
	if (used.size === 0) return captured;

	const rules: string[] = [];
	for (const [name, prop] of registeredProperties()) {
		if (used.has(name)) rules.push(prop.cssText);
	}
	if (rules.length === 0) return captured;

	const style = document.createElement('style');
	style.textContent = rules.join('\n');
	captured.clone.appendChild(style);
	return captured;
}

/**
 * Every custom-property name the snip references or defines, across the baked styles and
 * the synthesized state/pseudo rules. The synthesized rules are included so a registered
 * property a state rule depends on, such as the tailwind ring/shadow chain, keeps its @property
 * registration in the artifact, which is what lets resolve/vars.ts treat it as resolvable.
 */
function usedCustomProps(captured: Captured): Set<string> {
	const names = new Set<string>();
	const addRefs = (value: string): void => {
		let m: RegExpExecArray | null;
		VAR_REF.lastIndex = 0;
		while ((m = VAR_REF.exec(value)) !== null) if (m[1]) names.add(m[1]);
	};
	for (const v of captured.variables) names.add(v.name);
	for (const [, baked] of captured.bakedStyles) {
		for (const [prop, value] of baked) {
			if (prop.startsWith('--')) names.add(prop);
			addRefs(value);
		}
	}
	forEachSynthesizedDeclaration(captured, (decl) => {
		if (decl.prop.startsWith('--')) names.add(decl.prop);
		addRefs(decl.value);
	});
	return names;
}
