/**
 * convert/bem-factor.ts: factoring a shared base class out of near-identical rules.
 *
 * Identical-set dedup only merges rules that match exactly, so a family of buttons differing
 * in one color still ships its whole shared reset once per variant. This splits such families
 * into one base class holding the intersection plus modifiers carrying the differences.
 *
 * Two things make the split render-neutral. Every emitted selector is a flat single class of
 * equal specificity, so nothing outranks anything. And the family guard never separates a
 * shorthand from a longhand it overlaps, which is the only way source order between base and
 * modifier could change a used value. Order-sensitivity is asked of the engine rather than
 * read off a hand-written table, so it covers every shorthand the browser knows.
 *
 * Deterministic throughout, so the emitted css is byte-stable.
 */
import { uniqueElementClass, type ClassRule } from './bem-classes';

/** A group of rules that share a declaration subset, with that shared intersection. */
interface FactorGroup {
	base: Array<[string, string]>;
	members: ClassRule[];
}

/**
 * The minimum number of declarations a group must share for factoring to pay off: a
 * smaller overlap is not worth the extra base rule and class tokens, so it is left as
 * separate rules.
 */
const MIN_SHARED_DECLS = 4;

/** The minimum number of rules a group must hold to be worth a shared base class. */
const MIN_GROUP_SIZE = 2;

/**
 * The minimum fraction of a candidate rule's declarations that the shared base must
 * cover for it to join a group. Below this a rule overlaps only incidentally, on a common
 * font or transition timing, so admitting it would shrink the base to those few generic
 * declarations and strand each member's real commonality in its modifier.
 */
const MIN_COHESION = 0.5;

/**
 * Factors a shared base class out of near-identical rules. Groups the non-root rules
 * by the largest [prop, value] intersection they share and, for each group above the
 * overlap/size thresholds, emits a base class holding the intersection and demotes each
 * member to a modifier carrying only its remaining declarations. Every member element
 * then references `base base--modifier`, or just `base` when its modifier is empty.
 *
 * Render-neutral by construction: all selectors are flat single classes of equal
 * specificity, and the family guard, see familyGuardedBase, never splits a
 * shorthand/longhand family across the base and a modifier, so no property appears in
 * both rules for one element and the base-then-modifier order cannot change a used
 * value. The element resolves to exactly its original declaration set.
 *
 * Deterministic for byte-stable output: candidates are processed in class-name order
 * with a fixed greedy intersection, no enumeration-order or random dependence.
 *
 * @param rules - the deduped class rules, whose members are mutated into modifiers in place
 * @returns the rules in emission order (each base before its members) and a map from
 *   every grouped member's old class name to its new `base base--modifier` string
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

	// Emit each base immediately before its first member, preserving rule order
	// otherwise, and drop the now-empty members.
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
 * Greedily assigns the non-root rules to factor groups. Each unassigned rule in
 * class-name order seeds a group, then every other unassigned rule joins when it still
 * leaves the running intersection at or above the shared-declaration threshold. A group
 * is kept only when it has enough members and the family-guarded base is still large
 * enough. Otherwise its seed stays solo. Class-name ordering makes the result
 * deterministic.
 *
 * @returns the accepted groups, each with its guarded base and members
 */
function buildGroups(rules: ClassRule[]): FactorGroup[] {
	// Richest rules seed first so a dominant pattern, for example a button reset, forms its
	// group before a sparse rule can claim its members. Ties break by class name so the
	// order stays deterministic.
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
			// Admit a candidate only when the shared set is large enough AND covers most of
			// the candidate's own declarations. A rule that overlaps by just a few generic
			// declarations, say a shared font-family or a transition duration, would otherwise
			// pollute the group and shrink the base to those few, leaving the real members
			// duplicating their common declarations across modifiers.
			if (shared.size >= MIN_SHARED_DECLS && shared.size >= candidate.decls.length * MIN_COHESION) {
				base = shared;
				members.push(candidate);
			}
		}
		if (members.length < MIN_GROUP_SIZE) continue;
		const guarded = familyGuardedBase(base, members);
		if (guarded.size < MIN_SHARED_DECLS) continue;
		for (const member of members) assigned.add(member);
		// Order the base by the seed's original declaration order: deterministic, and it
		// preserves intra-family order for the conflict-free families left in the base.
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
 * Removes from the candidate base every property whose source order relative to another
 * declaration in the same member is render-significant, so hoisting it into the base
 * (which is emitted before every modifier) while its partner stays in a modifier could
 * reorder them and change the used value. Order matters exactly when two declarations
 * share a longhand: a shorthand and one of the longhands it sets, for example `border` and
 * `border-color`, or `padding` and `padding-top`, where whichever comes later wins for the
 * shared longhand. When a member holds such a pair both properties are excluded from the
 * base and kept whole inside each modifier, preserving the member's original order.
 *
 * Order-sensitivity is read from the engine. See orderSensitive. It is never a hand-listed
 * shorthand table, so it covers every shorthand the browser knows, and any it gains
 * later, and never misclassifies independent properties. Identical independent
 * declarations therefore still hoist to the base even when a sibling differs across
 * members. For the common case of computed-longhand-only rules the guard is a no-op.
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
 * Whether two declarations' relative order changes the result, asked of the engine: it
 * sets them on a throwaway style in both orders and compares the resulting declaration
 * blocks. Equal blocks mean the two are independent and safe to separate. Different
 * blocks mean they share a longhand one overrides, so order is significant. A false
 * positive only makes factoring more cautious, and the test has no false negatives, since
 * if order genuinely matters the blocks differ, so the guard stays render-safe. Memoized
 * per value pair, since the same declarations recur across a group's members.
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
 * Sets two declarations in order on a throwaway style and returns its resulting set of
 * declarations, sorted so only an order-dependent difference, one declaration overriding
 * the other, shows up, not the insertion order itself.
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
