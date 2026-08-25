/**
 * resolve/vars.ts: deciding which var() references can survive the snip.
 *
 * Runs during resolve. Baking deliberately kept authored var() references, but one only
 * renders if its definition travels. A definition on :root is re-emitted onto the snip root,
 * and one inside the subtree is already inline on its clone node. A definition on an ancestor
 * outside the subtree cannot survive, so its references resolve to the computed literal the
 * live element already produced.
 *
 * One sweep decides every reference. The only loop is the dependency closure of the root vars
 * that are kept.
 */
import type { Captured } from '../types';
import { pairedSubtrees } from '../reconcile/match';
import { synthesizedStyle, forEachSynthesizedDeclaration, rewriteSynthesizedDeclarations } from '../reconcile/synthesized';
import { registeredProperties } from '../reconcile/properties';

const VAR_REF = /var\(\s*(--[A-Za-z0-9_-]+)/g;

/**
 * Keeps every var() whose definition lives inside the snip and resolves the rest to their
 * computed literal.
 *
 * @param captured - clone + bakedStyles are mutated in place
 */
export function resolveVariables(captured: Captured): void {
	const cloneToOriginal = new Map<Element, Element>(
		pairedSubtrees(captured.root, captured.clone).map(([original, clone]) => [clone, original]),
	);

	// :root / html scoped definitions. They survive only if we re-emit them.
	const rootVars = new Map<string, string>();
	for (const v of captured.variables) {
		if (v.scope === 'root') rootVars.set(v.name, v.value);
	}
	// Ambient definitions a state rule may lean on: the foundation-scoped custom properties
	// from the `*`/html/body resets, such as older tailwind's `--tw-translate-x` chain, on top
	// of :root. Those carry no @property registration, so they inherit, and re-emitting a
	// referenced one on the root carries it to the subject. The state path alone uses this.
	const ambientVars = new Map<string, string>(rootVars);
	for (const rule of captured.foundationRules) {
		for (const [prop, value] of rule.properties) {
			if (prop.startsWith('--') && !ambientVars.has(prop)) ambientVars.set(prop, value);
		}
	}
	// A definition on an element inside the subtree already travels with that clone node,
	// baked as an inline custom property.
	const subtreeDefs = collectSubtreeDefs(captured);

	const neededRootVars = new Set<string>();
	const neededAmbientVars = new Set<string>();

	for (const [clone, baked] of captured.bakedStyles) {
		const original = cloneToOriginal.get(clone) ?? null;
		for (const [prop, value] of baked) {
			if (!value.includes('var(')) continue;
			const names = referencedVars(value);
			let mustResolveToLiteral = false;
			for (const name of names) {
				if (subtreeDefs.has(name)) continue; // Survives in subtree
				if (rootVars.has(name)) {
					neededRootVars.add(name); // Survives once re-emitted on the root
					continue;
				}
				mustResolveToLiteral = true; // Defined outside the snip, so it cannot survive
			}
			if (mustResolveToLiteral && original) {
				// The live element already resolved this var, so its computed literal is
				// the faithful replacement.
				const literal = getComputedStyle(original).getPropertyValue(prop);
				if (literal) {
					baked.set(prop, literal);
					setInline(clone, prop, literal);
				}
			}
		}
	}

	// The synthesized state and pseudo rules live in a <style>, not in bakedStyles, so the
	// loop above never saw their var() references. See resolveSynthesizedVariables.
	resolveSynthesizedVariables(captured, subtreeDefs, ambientVars, neededAmbientVars);

	// Re-emit every ambient definition a surviving reference needs, with its own closure.
	const needed = new Set<string>([...closeOver(neededRootVars, rootVars), ...closeOver(neededAmbientVars, ambientVars)]);
	emitAmbientVars(captured, ambientVars, needed);
}

/**
 * Resolves the var() references inside the synthesized <style>. A declaration is kept when
 * every reference in it resolves standalone, through any of three routes:
 *  - a surviving definition: a subtree-baked value, a re-emitted ambient one, or a custom
 *    property the synthesized rules define themselves, as in the tailwind `--tw-*` chain,
 *    taken to a fixpoint so a chain of such definitions holds.
 *  - a registered @property initial-value, which `var(--x)` yields even when nothing sets it.
 *  - a fallback on the reference itself, which always produces a value.
 *
 * A reference resolving through none of them is unreproducible. Its state-time value cannot be
 * copied, because the live element's computed value is the RESTING one, wrong for a
 * `:hover { color: var(--accent-hover) }`. That declaration is dropped with a warning rather
 * than baked to a wrong color, transitively through the fixpoint, so no dangling var() ships.
 *
 * @param captured - the synthesized <style> is rewritten in place, and warnings appended
 */
function resolveSynthesizedVariables(
	captured: Captured,
	subtreeDefs: Set<string>,
	ambientVars: Map<string, string>,
	neededAmbientVars: Set<string>,
): void {
	const style = synthesizedStyle(captured);
	if (!style || !(style.textContent ?? '').includes('var(')) return;

	const registered = registeredProperties();
	// A reference resolves through a surviving definition, a registered initial-value, or its
	// own fallback.
	const nameResolves = (name: string, synthOk: Set<string>): boolean =>
		subtreeDefs.has(name) || ambientVars.has(name) || synthOk.has(name) || registered.get(name)?.initialValue != null;
	const valueResolves = (value: string, synthOk: Set<string>): boolean =>
		varRefs(value).every((ref) => ref.hasFallback || nameResolves(ref.name, synthOk));

	// Custom properties the synthesized rules define themselves, name -> its values.
	const synthDefs = new Map<string, string[]>();
	forEachSynthesizedDeclaration(captured, (decl) => {
		if (!decl.prop.startsWith('--')) return;
		synthDefs.set(decl.prop, [...(synthDefs.get(decl.prop) ?? []), decl.value]);
	});

	// Fixpoint: a synth-defined var survives once one of its definitions resolves.
	const survivableSynth = new Set<string>();
	for (let changed = true; changed; ) {
		changed = false;
		for (const [name, values] of synthDefs) {
			if (survivableSynth.has(name)) continue;
			if (values.some((v) => valueResolves(v, survivableSynth))) {
				survivableSynth.add(name);
				changed = true;
			}
		}
	}

	rewriteSynthesizedDeclarations(captured, (decl) => {
		if (!decl.value.includes('var(')) return decl.value;
		if (!valueResolves(decl.value, survivableSynth)) {
			captured.warnings.push(
				`states: dropped "${decl.prop}" in "${decl.selector}"; its var() is defined outside the snip and has no resting-safe value`,
			);
			return null;
		}
		// Keep the ambient deps a surviving reference needs.
		for (const ref of varRefs(decl.value)) if (ambientVars.has(ref.name)) neededAmbientVars.add(ref.name);
		return decl.value;
	});
}

/**
 * Every var() reference in a value, each flagged for whether it carries a fallback, meaning a
 * top-level comma inside its own parens. One with a fallback always yields a value; one
 * without must resolve by name.
 */
function varRefs(value: string): Array<{ name: string; hasFallback: boolean }> {
	const refs: Array<{ name: string; hasFallback: boolean }> = [];
	let i = value.indexOf('var(');
	while (i !== -1) {
		let depth = 0;
		let hasFallback = false;
		let j = i + 3; // The '(' of var(.
		for (; j < value.length; j++) {
			const ch = value[j];
			if (ch === '(') depth++;
			else if (ch === ')') { depth--; if (depth === 0) { j++; break; } }
			else if (ch === ',' && depth === 1) hasFallback = true; // A comma directly inside var()'s parens.
		}
		const name = /^\s*(--[A-Za-z0-9_-]+)/.exec(value.slice(i + 4, j));
		if (name?.[1]) refs.push({ name: name[1], hasFallback });
		i = value.indexOf('var(', j);
	}
	return refs;
}

/**
 * Re-emits the ambient definitions a surviving reference needs onto the snip root clone, where
 * they inherit down. The :root ones also flip their source-of-truth flag.
 *
 * @param captured - bakedStyles + clone mutated in place
 */
function emitAmbientVars(captured: Captured, ambientVars: Map<string, string>, needed: Set<string>): void {
	const rootClone = captured.clone;
	const baked = captured.bakedStyles.get(rootClone) ?? new Map<string, string>();
	for (const name of needed) {
		const value = ambientVars.get(name);
		if (value === undefined || baked.has(name)) continue;
		baked.set(name, value);
		setInline(rootClone, name, value);
		// Flip the source-of-truth flag for the :root ones, for transparency/emit.
		for (const v of captured.variables) if (v.name === name && v.scope === 'root') v.resolved = true;
	}
	captured.bakedStyles.set(rootClone, baked);
}

/**
 * Expands a set of needed root vars to cover the vars their own values reference, since one
 * root var can be defined in terms of another. A closure within the definitions.
 */
function closeOver(initial: Set<string>, rootVars: Map<string, string>): Set<string> {
	const needed = new Set<string>();
	const queue = [...initial];
	while (queue.length > 0) {
		const name = queue.pop();
		if (!name || needed.has(name)) continue;
		needed.add(name);
		const value = rootVars.get(name);
		if (!value) continue;
		for (const dep of referencedVars(value)) {
			if (rootVars.has(dep) && !needed.has(dep)) queue.push(dep);
		}
	}
	return needed;
}

/** Every --name referenced by var() in a value string. */
function referencedVars(value: string): string[] {
	const names: string[] = [];
	let m: RegExpExecArray | null;
	VAR_REF.lastIndex = 0;
	while ((m = VAR_REF.exec(value)) !== null) {
		if (m[1]) names.push(m[1]);
	}
	return names;
}

/** All custom-property names defined on any element inside the snip subtree. */
function collectSubtreeDefs(captured: Captured): Set<string> {
	const defs = new Set<string>();
	for (const [, baked] of captured.bakedStyles) {
		for (const prop of baked.keys()) {
			if (prop.startsWith('--')) defs.add(prop);
		}
	}
	return defs;
}

/** Safely set a property on a clone element's inline style. */
function setInline(clone: Element, prop: string, value: string): void {
	try {
		(clone as HTMLElement).style.setProperty(prop, value);
	} catch {
		// Invalid declaration for this element, so ignore.
	}
}
