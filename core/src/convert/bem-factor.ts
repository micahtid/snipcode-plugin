/**
 * convert/bem-factor.ts: factoring a shared base class out of near-identical rules.
 *
 * Identical-set dedup only merges rules that match exactly, so a family of buttons differing
 * in one color still ships its whole shared reset once per variant. This splits such families
 * into one base class holding the intersection plus modifiers carrying the differences.
 *
 * Two things make the split render-neutral. Every emitted selector is a flat single class of
 * equal specificity, so nothing outranks anything. And the family guard never separates a
 * shorthand from a longhand it overlaps, the only way source order between base and modifier
 * could change a used value. Order-sensitivity is asked of the engine rather than read off a
 * table, so it covers every shorthand the browser knows.
 *
 * Deterministic throughout, so the emitted css is byte-stable.
 */
import { uniqueElementClass, type ClassRule } from './bem-classes';

/** A group of rules that share a declaration subset, with that shared intersection. */
interface FactorGroup {
	base: Array<[string, string]>;
	members: ClassRule[];
}

/** The fewest shared declarations worth an extra base rule and its class tokens. */
const MIN_SHARED_DECLS = 4;

/** The minimum number of rules a group must hold to be worth a shared base class. */
const MIN_GROUP_SIZE = 2;

/**
 * How much of a candidate's own declarations the shared base must cover before it joins.
 * Below this the overlap is incidental, a common font or timing. Admitting it shrinks the base
 * to those few and strands each member's real commonality in its modifier.
 */
const MIN_COHESION = 0.5;

/**
 * Factors a shared base class out of near-identical rules. Group the non-root rules by their
 * largest shared intersection, emit a base class holding it, then demote each member to a
 * modifier carrying what is left. Every member element then reads `base base--modifier`, or
 * just `base` when its modifier is empty.
 *
 * Render-neutral by construction. Every selector is a flat single class of equal specificity,
 * and familyGuardedBase never splits a shorthand from a longhand it overlaps. So no property
 * appears in both rules for one element, and the base-then-modifier order cannot change a used
 * value. Deterministic too: class-name order with a fixed greedy intersection.
 *
 * @param rules - the deduped class rules, whose members are mutated into modifiers in place
 * @returns the rules in emission order, each base before its members, plus a map from every
 *   grouped member's old class name to its new `base base--modifier` string
 */
export function factorBaseClasses(
	block: string,
	rules: ClassRule[],
	counters: Map<string, number>,
): { rules: ClassRule[]; renames: Map<string, string> } {
	const groups = buildGroups(rules);
	if (groups.length === 0) return { rules, renames: new Map() };

	const renames = new Map<string, string>();
	const dropped = new Set<ClassRule>(); // Members whose modifier is empty: base only.
	const baseOf = new Map<ClassRule, ClassRule>(); // Member -> its base rule.

	for (const group of groups) {
		const baseClassName = uniqueElementClass(block, 'group', counters);
		const baseRule: ClassRule = { className: baseClassName, decls: group.base, isRoot: false };
		const baseSet = new Set(group.base.map(([p, v]) => `${p}:${v}`));
		let variant = 0;
		for (const member of group.members) {
			baseOf.set(member, baseRule);
			const modifierDecls = member.decls.filter(([p, v]) => !baseSet.has(`${p}:${v}`));
			const oldClassName = member.className;
			if (modifierDecls.length === 0) {
				// The member's whole set is the base, so it needs no modifier rule.
				renames.set(oldClassName, baseClassName);
				dropped.add(member);
				continue;
			}
			variant++;
			const modifierClassName = `${baseClassName}--${variant}`;
			member.className = modifierClassName;
			member.decls = modifierDecls;
			renames.set(oldClassName, `${baseClassName} ${modifierClassName}`);
		}
	}

	// Each base goes immediately before its first member, rule order otherwise preserved.
	const emitted = new Set<ClassRule>();
	const ordered: ClassRule[] = [];
	for (const rule of rules) {
		const base = baseOf.get(rule);
		if (base && !emitted.has(base)) {
			ordered.push(base);
			emitted.add(base);
		}
		if (!dropped.has(rule)) ordered.push(rule);
	}
	return { rules: ordered, renames };
}

/** Sets each grouped member element's class to its `base base--modifier` replacement. */
export function applyBaseClasses(elements: HTMLElement[], renames: Map<string, string>): void {
	if (renames.size === 0) return;
	for (const el of elements) {
		const current = el.getAttribute('class');
		if (current === null) continue;
		const replacement = renames.get(current);
		if (replacement !== undefined) el.setAttribute('class', replacement);
	}
}

/**
 * Greedily assigns the non-root rules to factor groups. Each unassigned rule seeds a group,
 * and another joins when it leaves the running intersection at or above the threshold. A group
 * is kept only with enough members and a large enough guarded base; otherwise its seed stays
 * solo. Ordering by class name keeps the result deterministic.
 *
 * @returns the accepted groups, each with its guarded base and members
 */
function buildGroups(rules: ClassRule[]): FactorGroup[] {
	// Richest rules seed first, so a dominant pattern such as a button reset forms its group
	// before a sparse rule claims its members. Ties break by class name.
	const candidates = rules
		.filter((r) => !r.isRoot)
		.sort((a, b) => b.decls.length - a.decls.length || a.className.localeCompare(b.className));
	const assigned = new Set<ClassRule>();
	const groups: FactorGroup[] = [];

	for (const seed of candidates) {
		if (assigned.has(seed)) continue;
		let base = new Map(seed.decls);
		const members = [seed];
		for (const candidate of candidates) {
			if (candidate === seed || assigned.has(candidate)) continue;
			const shared = intersectDecls(base, candidate.decls);
			// Both conditions. Otherwise a rule overlapping on a shared font-family alone
			// joins and shrinks the base, leaving the real members duplicating their common
			// declarations across modifiers.
			if (shared.size >= MIN_SHARED_DECLS && shared.size >= candidate.decls.length * MIN_COHESION) {
				base = shared;
				members.push(candidate);
			}
		}
		if (members.length < MIN_GROUP_SIZE) continue;
		const guarded = familyGuardedBase(base, members);
		if (guarded.size < MIN_SHARED_DECLS) continue;
		for (const member of members) assigned.add(member);
		// The seed's own declaration order: deterministic, and it preserves intra-family order
		// for the conflict-free families left in the base.
		const baseDecls = seed.decls.filter(([p, v]) => guarded.get(p) === v);
		groups.push({ base: baseDecls, members });
	}
	return groups;
}

/** The [prop, value] pairs shared by an intersection map and a declaration list. */
function intersectDecls(base: Map<string, string>, decls: Array<[string, string]>): Map<string, string> {
	const other = new Map(decls);
	const out = new Map<string, string>();
	for (const [prop, value] of base) {
		if (other.get(prop) === value) out.set(prop, value);
	}
	return out;
}

/**
 * Drops from the candidate base every property whose order against another declaration in the
 * same member matters. The base is emitted before every modifier, so hoisting one half of such
 * a pair would reorder it against the other.
 *
 * Order matters exactly when two declarations share a longhand: `border` against
 * `border-color`, or `padding` against `padding-top`, where the later one wins. A member
 * holding such a pair keeps both properties whole inside its modifier.
 *
 * Order-sensitivity is read from the engine (see orderSensitive), never a hand-listed table,
 * so it covers every shorthand the browser knows and misclassifies no independent property.
 * For the common case of longhand-only rules the guard is a no-op.
 *
 * @returns the subset of the base that is safe to hoist
 */
function familyGuardedBase(base: Map<string, string>, members: ClassRule[]): Map<string, string> {
	const probe = document.createElement('div');
	const memo = new Map<string, boolean>();
	const unsafe = new Set<string>();
	for (const member of members) {
		const decls = member.decls;
		for (let i = 0; i < decls.length; i++) {
			for (let j = i + 1; j < decls.length; j++) {
				const a = decls[i] as [string, string];
				const b = decls[j] as [string, string];
				if (orderSensitive(probe, memo, a, b)) {
					unsafe.add(a[0]);
					unsafe.add(b[0]);
				}
			}
		}
	}
	const out = new Map<string, string>();
	for (const [prop, value] of base) {
		if (!unsafe.has(prop)) out.set(prop, value);
	}
	return out;
}

/**
 * Whether two declarations' order changes the result, asked of the engine by setting them on a
 * throwaway style both ways and comparing the blocks. Equal means independent; different means
 * they share a longhand one overrides. A false positive only makes factoring more cautious,
 * and there are no false negatives, since real order-dependence always shows. Memoized per
 * value pair, because the same declarations recur across a group's members.
 */
function orderSensitive(probe: HTMLElement, memo: Map<string, boolean>, a: [string, string], b: [string, string]): boolean {
	if (a[0] === b[0]) return false;
	const key = a[0] < b[0] ? `${a[0]}:${a[1]}|${b[0]}:${b[1]}` : `${b[0]}:${b[1]}|${a[0]}:${a[1]}`;
	const cached = memo.get(key);
	if (cached !== undefined) return cached;
	const result = declBlock(probe, a, b) !== declBlock(probe, b, a);
	memo.set(key, result);
	return result;
}

/**
 * Sets two declarations in order on a throwaway style and returns the resulting declarations,
 * sorted so only an override shows up rather than the insertion order itself.
 */
function declBlock(probe: HTMLElement, first: [string, string], second: [string, string]): string {
	const style = probe.style;
	style.cssText = '';
	style.setProperty(first[0], first[1]);
	style.setProperty(second[0], second[1]);
	const out: string[] = [];
	for (let i = 0; i < style.length; i++) {
		const prop = style.item(i);
		out.push(`${prop}:${style.getPropertyValue(prop)}`);
	}
	return out.sort().join(';');
}
