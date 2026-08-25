/**
 * minimize/merge.ts: collapsing identical rules into selector lists.
 *
 * Runs in minimize, after normalize. Reconcile gives every element its own class and rule, so
 * a grid of eight identical cards emits the same block eight times, and pruning drives others
 * to match. Each group collapses into one rule with a comma-joined selector.
 *
 * The merged rule takes the last group member's position, which moves the block later in the
 * cascade. That is what the oracle checks, over the elements the group matches, so a merge
 * stepping past an overriding rule is reverted while the rest stand. Withheld state and pseudo
 * rules merge under syntactic checks instead, since the resting oracle is blind to them.
 */
import type { Captured } from '../types';
import { withOracle, type RenderOracle } from './oracle';
import { inScopeRule, serializeRules, WITHHELD } from './declarations';
import { splitTopLevel } from '../utils/css-split';

/**
 * The dynamic pseudo-classes and every pseudo-element, stripped from a withheld selector to
 * find the elements it targets. What remains matches those elements at rest. The
 * dynamic-class alternatives are longest-first so `:focus-visible` is consumed whole.
 */
const DYNAMIC_PSEUDO = /::[\w-]+(?:\([^)]*\))?|:(?:hover|focus-visible|focus-within|focus|active|visited|link|target)(?![-\w])/gi;

/**
 * Merges rules with identical declaration blocks into selector lists. Each merge is
 * oracle-verified and reverted if it is not render-neutral, and any infrastructure failure
 * returns the input unchanged.
 *
 * @param captured - source of the viewport size. Warnings are appended here on skip.
 */
export async function mergeCss(css: string, captured: Captured, markup: string): Promise<string> {
	return withOracle(css, captured, markup, 'merge: skipped', (oracle) => {
		oracle.captureReference();
		const topRules = Array.from(oracle.sheet.cssRules);

		// Group the in-scope rules by declaration block, document order kept within a group.
		// An emptied rule has no block to share.
		const byBody = new Map<string, CSSStyleRule[]>();
		for (const rule of topRules) {
			const styleRule = inScopeRule(rule);
			if (!styleRule || styleRule.style.length === 0) continue;
			const body = styleRule.style.cssText;
			const group = byBody.get(body);
			if (group) group.push(styleRule);
			else byBody.set(body, [styleRule]);
		}

		// Merge each group of two or more, in selector order for determinism.
		const groups = [...byBody.values()].filter((g) => g.length >= 2);
		groups.sort((a, b) => a[0]!.selectorText.localeCompare(b[0]!.selectorText));
		for (const group of groups) mergeGroup(oracle, group);

		// The withheld state and pseudo rules merge under the syntactic checks instead.
		mergeWithheldRules(oracle, topRules);

		return serializeRules(topRules);
	});
}

/**
 * Merges one group of identical-body rules in place, reverting when it is not render-neutral.
 * The last rule keeps the block and takes the joined selector; the earlier ones are emptied so
 * serialize drops them. Verified over the matched elements and their descendants, which is all
 * a position change can reach.
 */
function mergeGroup(oracle: RenderOracle, group: CSSStyleRule[]): void {
	const keeper = group[group.length - 1]!;
	const savedSelector = keeper.selectorText;
	const savedBodies = group.map((r) => r.style.cssText);

	const affected = oracle.subtreeTargets(matchedElements(oracle, group));
	keeper.selectorText = group.map((r) => r.selectorText).join(', ');
	for (let i = 0; i < group.length - 1; i++) group[i]!.style.cssText = '';

	if (!oracle.matchesSubset(affected)) {
		keeper.selectorText = savedSelector;
		group.forEach((r, i) => (r.style.cssText = savedBodies[i]!));
	}
}

/** The elements any rule in the group matches, before the merge changes any selector. */
function matchedElements(oracle: RenderOracle, group: CSSStyleRule[]): Element[] {
	const seen = new Set<Element>();
	for (const rule of group) {
		try {
			for (const el of Array.from(oracle.body.querySelectorAll(rule.selectorText))) seen.add(el);
		} catch {
			// An unsupported selector matches nothing here, and the subtree check still guards the rest.
		}
	}
	return [...seen];
}

/** A top-level style rule with its position and the elements it participates in styling. */
interface StyleRuleRef {
	rule: CSSStyleRule;
	pos: number;
	withheld: boolean;
	/** The elements it can style, its dynamic pseudos stripped, or null when undeterminable. */
	targets: Set<Element> | null;
}

/**
 * Merges withheld state and pseudo rules with identical bodies, keeping the first rule's
 * position. The resting oracle is blind to these, so a merge is accepted only by construction,
 * on three syntactic checks. The bodies are byte-identical. A selector list changes no
 * selector's specificity. And no rule a member is reordered past could flip a cascade result,
 * per safeToMergeWithheld. Most groups collapse; one that could flip stays as written.
 *
 * @param oracle - the mounted render, used only to resolve which elements a selector targets
 * @param topRules - the frame stylesheet's top-level rules, mutated in place
 */
function mergeWithheldRules(oracle: RenderOracle, topRules: CSSRule[]): void {
	// Every top-level style rule with the elements it can style. A merge is then checked
	// against each rule it would reorder past, rather than assuming the withheld ones adjoin.
	const styleRules: StyleRuleRef[] = [];
	for (let pos = 0; pos < topRules.length; pos++) {
		const rule = topRules[pos]!;
		if (rule.type !== CSSRule.STYLE_RULE) continue;
		const styleRule = rule as CSSStyleRule;
		if (styleRule.style.length === 0) continue;
		const withheld = WITHHELD.test(styleRule.selectorText || '');
		styleRules.push({ rule: styleRule, pos, withheld, targets: ruleTargets(oracle, styleRule.selectorText, withheld) });
	}

	// Group the withheld rules by declaration block, document order preserved within each group.
	const byBody = new Map<string, StyleRuleRef[]>();
	for (const ref of styleRules) {
		if (!ref.withheld) continue;
		const group = byBody.get(ref.rule.style.cssText);
		if (group) group.push(ref);
		else byBody.set(ref.rule.style.cssText, [ref]);
	}

	const groups = [...byBody.values()].filter((g) => g.length >= 2);
	groups.sort((a, b) => a[0]!.rule.selectorText.localeCompare(b[0]!.rule.selectorText));
	for (const group of groups) {
		if (!safeToMergeWithheld(group, styleRules)) continue;
		const keeper = group[0]!.rule;
		keeper.selectorText = group.map((w) => w.rule.selectorText).join(', ');
		for (let i = 1; i < group.length; i++) group[i]!.rule.style.cssText = ''; // Dropped by serialize.
	}
}

/**
 * Whether merging a withheld group is render-neutral. The selectors collapse onto the first
 * member's position, so every later member moves earlier, past the rules in between. Safe when
 * none of those could flip a cascade result with a moving member (see couldFlip).
 */
function safeToMergeWithheld(group: StyleRuleRef[], styleRules: StyleRuleRef[]): boolean {
	const first = group[0]!.pos;
	const groupPositions = new Set(group.map((w) => w.pos));
	for (const other of styleRules) {
		if (other.pos <= first || groupPositions.has(other.pos)) continue;
		// A member moves past `other` only when its old position is later. Block on any such
		// move that could flip a result.
		for (const member of group) {
			if (member.pos <= other.pos) continue;
			if (couldFlip(member, other)) return false;
		}
	}
	return true;
}

/**
 * Whether reordering `member` before `other` could flip which rule wins somewhere. All three
 * must hold: they target a common element, they declare a common longhand at the same
 * importance with different values, and their selectors carry equal specificity. Only then
 * does source order decide. Fail any one and the winner is fixed whatever the order. An
 * undeterminable target set counts as overlapping.
 */
function couldFlip(member: StyleRuleRef, other: StyleRuleRef): boolean {
	if (!member.targets || !other.targets) return true;
	if (!intersects(member.targets, other.targets)) return false;
	if (!sharesDecidingProperty(member.rule.style, other.rule.style)) return false;
	return specificitiesCanTie(member.rule.selectorText, other.rule.selectorText);
}

/**
 * Whether two blocks share a longhand that source order would decide between: both declare it,
 * same importance, different values. A matching value or a differing importance settles it
 * without order. The cssom stores each block as expanded longhands with per-longhand priority,
 * so `background` against `background-color` compares correctly.
 */
function sharesDecidingProperty(a: CSSStyleDeclaration, b: CSSStyleDeclaration): boolean {
	for (let i = 0; i < a.length; i++) {
		const name = a.item(i);
		const bValue = b.getPropertyValue(name);
		if (bValue === '') continue; // `b` does not declare this longhand.
		if (a.getPropertyValue(name) !== bValue && a.getPropertyPriority(name) === b.getPropertyPriority(name)) return true;
	}
	return false;
}

/** Whether some selector of each list shares a specificity, so an element could tie between them. */
function specificitiesCanTie(a: string, b: string): boolean {
	const bSpecs = splitSelectorList(b).map(specificity);
	for (const sa of splitSelectorList(a)) {
		const spec = specificity(sa);
		if (bSpecs.some((sb) => sb[0] === spec[0] && sb[1] === spec[1] && sb[2] === spec[2])) return true;
	}
	return false;
}

/**
 * The [id, class, type] specificity of one selector. The emitted stylesheet uses only simple
 * compounds, with no `:is()` whose weight depends on its argument, so a token count is exact.
 * An id raises the first rank, a class or attribute or pseudo-class the second, a type or
 * pseudo-element the third.
 */
function specificity(selector: string): [number, number, number] {
	let s = selector.trim();
	let a = 0;
	let b = 0;
	let c = 0;
	s = s.replace(/::[\w-]+/g, () => (c++, ' ')); // Pseudo-elements first, so their colons are not recounted.
	s = s.replace(/#[\w-]+/g, () => (a++, ' '));
	s = s.replace(/\[[^\]]*\]/g, () => (b++, ' '));
	s = s.replace(/\.[\w-]+/g, () => (b++, ' '));
	s = s.replace(/:[\w-]+(?:\([^)]*\))?/g, () => (b++, ' ')); // Pseudo-classes.
	s.replace(/[a-zA-Z][\w-]*/g, () => (c++, ' ')); // Remaining bare identifiers are type selectors.
	return [a, b, c];
}

/**
 * Splits a selector list on top-level commas, keeping bracket, paren, and quoted spans intact.
 * Entries keep their whitespace, which the caller trims, and a trailing empty is dropped.
 */
function splitSelectorList(list: string): string[] {
	const out = splitTopLevel(list, ',', { brackets: true });
	if (out[out.length - 1]?.trim() === '') out.pop();
	return out;
}

/**
 * The elements a rule can style: its selector directly for a resting rule, or with the dynamic
 * pseudos stripped for a withheld one, which finds the host element. Null when what remains is
 * empty or will not parse.
 */
function ruleTargets(oracle: RenderOracle, selector: string, withheld: boolean): Set<Element> | null {
	const base = withheld ? selector.replace(DYNAMIC_PSEUDO, '').trim() : selector;
	if (!base) return null;
	try {
		return new Set(Array.from(oracle.body.querySelectorAll(base)));
	} catch {
		return null;
	}
}

/** Whether two element sets share a member. */
function intersects(a: Set<Element>, b: Set<Element>): boolean {
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	for (const el of small) if (large.has(el)) return true;
	return false;
}
