/**
 * minimize/atrules.ts: dropping @property registrations nothing reads.
 *
 * Runs in minimize, after merge. A utility bundle registers dozens of custom properties, and
 * once prune has deleted the declarations that used them most govern nothing.
 *
 * Liveness is a read count judged textually, never by the resting oracle. getComputedStyle
 * enumerates a registered custom property, so dropping an unreferenced registration changes
 * that computed value and the oracle would veto a no-op. A name only written, or appearing
 * only in its own registration, governs no paint.
 *
 * Var inlining removes reference sites, so registrations can die after it. The purge is
 * idempotent and runs again there.
 */
import { serializeRules } from './declarations';
import { holdsChildRules, parseCss } from '../utils/css-rules';

/** A grouping rule (@media/@layer/@supports) whose child rules can be walked and deleted. */
type RuleContainer = CSSStyleSheet | CSSGroupingRule;

/** One registered @property in the parsed sheet, recording where it sits so it can be deleted. */
interface PropertyRuleRef {
	container: RuleContainer;
	index: number;
	name: string;
}

/**
 * Drops every `@property` registration whose custom-property name is never read, meaning no
 * var() reference and no transition or animation mention anywhere in the sheet. Graceful by
 * contract: css that will not parse, or carries no registration, comes back unchanged. A pure
 * function of the input text.
 *
 * @returns the stylesheet with dead registrations removed, or the input unchanged
 */
export function purgeAtRules(css: string): string {
	if (!css.trim() || !/@property\s/.test(css)) return css;
	const sheet = parseCss(css);
	if (!sheet) return css;
	const registrations: PropertyRuleRef[] = [];
	collectPropertyRules(sheet, registrations);
	const dead = registrations.filter((r) => nameReads(css, r.name) === 0);
	if (dead.length === 0) return css;
	deleteRules(dead);
	return serializeRules(Array.from(sheet.cssRules));
}

/**
 * Collects every `@property` rule under a container. Detected structurally by its name and
 * syntax descriptors, because CSSPropertyRule is absent from some dom lib versions. Grouping
 * rules are descended, so a registration inside an @layer is found too.
 */
function collectPropertyRules(container: RuleContainer, out: PropertyRuleRef[]): void {
	const rules = container.cssRules;
	for (let i = 0; i < rules.length; i++) {
		const rule = rules[i]!;
		const r = rule as unknown as { name?: unknown; syntax?: unknown };
		if (typeof r.name === 'string' && typeof r.syntax === 'string' && r.name.startsWith('--')) {
			out.push({ container, index: i, name: r.name });
		} else if (holdsChildRules(rule)) {
			collectPropertyRules(rule, out);
		}
	}
}

/**
 * Deletes registrations from their containers, grouped by container and in descending index
 * order, so each deletion leaves the indices still to delete valid.
 */
function deleteRules(refs: PropertyRuleRef[]): void {
	const byContainer = new Map<RuleContainer, number[]>();
	for (const ref of refs) {
		const list = byContainer.get(ref.container);
		if (list) list.push(ref.index);
		else byContainer.set(ref.container, [ref.index]);
	}
	for (const [container, indices] of byContainer) {
		for (const index of indices.sort((a, b) => b - a)) container.deleteRule(index);
	}
}

/**
 * How many times a custom-property name is read: a `var()` reference, or a mention in a
 * transition or animation list, where it names a property to interpolate.
 *
 * A declaration that sets the name is a write, not a read, and keeps no registration alive,
 * because a value nothing reads governs no paint. Its own `@property` line is not a read
 * either. The token boundary rejects a name that prefixes another, `--tw-ring` inside
 * `--tw-ring-color`, since a hyphen is a name character rather than a word boundary.
 */
function nameReads(css: string, name: string): number {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const boundary = `(?<![-\\w])${escaped}(?![-\\w])`;
	let reads = (css.match(new RegExp(`var\\(\\s*${boundary}`, 'g')) || []).length;
	// A name listed in a transition or animation value names a property to interpolate, a read.
	for (const decl of css.matchAll(/(?:transition|transition-property|animation|animation-name)\s*:[^;}]*/g)) {
		reads += (decl[0].match(new RegExp(boundary, 'g')) || []).length;
	}
	return reads;
}
