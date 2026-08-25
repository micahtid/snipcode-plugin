/**
 * minimize/prune.ts: deleting declarations that change no pixel.
 *
 * Runs first in minimize, after convert/clean. Reconcile bakes a full computed style onto
 * every element, so the sheet restates inherited values and ua defaults by the hundred. This
 * is dead-code elimination one level below clean.ts, which drops whole unused rules but never
 * looks inside a matched one.
 *
 * Declarations are indexed through the browser's own parser in the oracle frame, never by
 * regex, so data-uri braces and nested functions cannot mislead it. Deletion is delta
 * debugging: remove a chunk, ask the oracle, accept only an unchanged render, otherwise
 * restore and split. A cheap pre-pass batches the declarations most likely dead; whatever it
 * misses the bisection still finds, so it only saves time.
 *
 * State, pseudo, and at rules are out of scope: their selectors carry the interactive and
 * generated-content fidelity earlier phases earned. See WITHHELD.
 */
import type { Captured } from '../types';
import { withOracle, type RenderOracle } from './oracle';
import { parseSegments, inScopeRule, serializeRules, type Segment } from './declarations';

/**
 * Properties held out of deletion, because the resting subtree oracle cannot verify them.
 * Animation and transition carry motion: the oracle freezes them, so they look inert at rest
 * and deleting one would silently strip a reveal or hover. Counter properties act across the
 * tree, changing what a later sibling's generated content renders, which is outside the
 * subtree the check can see.
 */
const UNVERIFIABLE_PROP = /^(animation|transition|counter-)/;

/**
 * Wall-time ceiling for one component's minimization. The cost is not the mount, which
 * profiling put at a few hundred milliseconds, but the bisection's per-check style recalc. On
 * the two most restated components in the corpus that recalc reaches the ceiling and the pass
 * stops early. That is the valve working: every deletion accepted so far is already
 * render-verified, so the partial result is safe and still deterministic. Ordinary components
 * finish well under a second.
 */
const BUDGET_MS = 20_000;

/**
 * The css properties that inherit, from the spec. Only the pre-pass reads it, to guess which
 * declarations restate an inherited value. The oracle verifies every guess, so a missing or
 * extra entry shifts work between the pre-pass and the bisection, never the result.
 */
const INHERITED = new Set<string>([
	'azimuth', 'border-collapse', 'border-spacing', 'caption-side', 'caret-color', 'color',
	'color-scheme', 'cursor', 'direction', 'empty-cells', 'font', 'font-family', 'font-feature-settings',
	'font-kerning', 'font-language-override', 'font-optical-sizing', 'font-size', 'font-size-adjust',
	'font-stretch', 'font-style', 'font-synthesis', 'font-variant', 'font-variant-alternates',
	'font-variant-caps', 'font-variant-east-asian', 'font-variant-ligatures', 'font-variant-numeric',
	'font-variant-position', 'font-variation-settings', 'font-weight', 'hyphens', 'image-rendering',
	'letter-spacing', 'line-break', 'line-height', 'list-style', 'list-style-image', 'list-style-position',
	'list-style-type', 'orphans', 'overflow-wrap', 'paint-order', 'pointer-events', 'print-color-adjust',
	'quotes', 'ruby-align', 'ruby-position', 'tab-size', 'text-align', 'text-align-last', 'text-anchor',
	'text-combine-upright', 'text-decoration-skip-ink', 'text-emphasis', 'text-emphasis-color',
	'text-emphasis-position', 'text-emphasis-style', 'text-indent', 'text-justify', 'text-orientation',
	'text-rendering', 'text-shadow', 'text-size-adjust', 'text-transform', 'text-underline-offset',
	'text-underline-position', 'text-wrap', 'visibility', 'white-space', 'white-space-collapse', 'widows',
	'word-break', 'word-spacing', 'word-wrap', 'writing-mode',
	'-webkit-font-smoothing', '-webkit-text-fill-color', '-webkit-text-stroke-color',
	'-webkit-text-stroke-width', '-webkit-text-stroke', '-webkit-text-size-adjust', '-webkit-locale',
]);

/**
 * Measurement of one minimization run. Production call sites ignore it; the measurement
 * harness reads it for deletion rate, char shrink, and wall time.
 */
export interface MinimizeStats {
	/** Wall time of the minimization step in milliseconds. */
	ms: number;
	/** In-scope declarations before minimization. */
	declsBefore: number;
	/** In-scope declarations surviving after minimization. */
	declsAfter: number;
	/** Stylesheet length in characters before minimization. */
	charsBefore: number;
	/** Stylesheet length in characters after minimization. */
	charsAfter: number;
}

/**
 * Deletes every declaration whose removal the computed-style oracle confirms is invisible.
 * Graceful by contract: any infrastructure failure warns and returns the css unchanged, so a
 * snip always ships. Deterministic too, since the only await is a one-time font settle at
 * setup and the bisection then runs synchronously in a fixed order.
 *
 * @param captured - source of the viewport size. Warnings are appended here on skip.
 * @param stats - optional measurement sink, filled with this run's numbers when provided
 */
export async function minimizeCss(css: string, captured: Captured, markup: string, stats?: MinimizeStats): Promise<string> {
	if (stats) fillNoOpStats(stats, css);
	// withOracle owns the fallback: a mid-run failure discards the frame's partial edits and
	// ships the original css, never a half-minimized stylesheet.
	return withOracle(css, captured, markup, 'minimize: skipped', (oracle) => {
		const t0 = now();
		const result = run(oracle, stats);
		if (stats) stats.ms = now() - t0;
		return result;
	});
}

/** Initializes a stats sink to a no-op run, so a skip still reports coherent numbers. */
function fillNoOpStats(stats: MinimizeStats, css: string): void {
	stats.ms = 0;
	stats.declsBefore = 0;
	stats.declsAfter = 0;
	stats.charsBefore = css.length;
	stats.charsAfter = css.length;
}

/** A minimizable rule with its parsed segments and a per-segment kept flag. */
interface MinRule {
	rule: CSSStyleRule;
	segs: Segment[];
	kept: boolean[];
}

/** A candidate declaration: which minimizable rule and which segment within it. */
interface DeclRef {
	rIdx: number;
	segIdx: number;
}

/**
 * Runs the minimization against a mounted oracle. The frame's own stylesheet is the working
 * copy: declarations come out of it, get checked, and are kept or restored.
 *
 * @param oracle - the mounted render whose stylesheet is minimized in place
 */
function run(oracle: RenderOracle, stats?: MinimizeStats): string {
	oracle.captureReference();
	const topRules = Array.from(oracle.sheet.cssRules);

	// Index every in-scope rule's declarations through the parser: author segments with
	// shorthands intact, and a candidate is any segment that is not motion or custom.
	// Everything else is preserved. A per-rule kept flag is the whole working state. A removal
	// rebuilds the rule's cssText from the kept segments, a full re-parse each time. The frame
	// then renders exactly as a fresh parse of the emitted text would. Per-longhand
	// removeProperty is avoided: it can leave the cssom serializing differently than it
	// renders, which makes the oracle unsound.
	const rules: MinRule[] = [];
	const index: DeclRef[] = [];
	for (const rule of topRules) {
		const styleRule = inScopeRule(rule);
		if (!styleRule) continue;
		const segs = parseSegments(styleRule.style.cssText);
		const rIdx = rules.push({ rule: styleRule, segs, kept: segs.map(() => true) }) - 1;
		for (let s = 0; s < segs.length; s++) {
			const prop = segs[s]!.prop;
			if (UNVERIFIABLE_PROP.test(prop) || prop.startsWith('--')) continue;
			index.push({ rIdx, segIdx: s });
		}
	}
	if (stats) {
		stats.declsBefore = index.length;
		// In-scope style rules only, so the shrink metric is not swamped by the inlined fonts
		// and image data-uris that dominate the byte count and are never touched here.
		stats.charsBefore = rules.reduce((sum, r) => sum + r.rule.cssText.length, 0);
	}
	if (index.length === 0) return serializeRules(topRules);

	const rebuild = (rIdx: number): void => {
		const r = rules[rIdx]!;
		r.rule.style.cssText = r.segs.filter((_, s) => r.kept[s]).map((seg) => seg.decl).join('; ');
	};
	const setKept = (idxs: number[], value: boolean): void => {
		const dirty = new Set<number>();
		for (const i of idxs) {
			const ref = index[i]!;
			rules[ref.rIdx]!.kept[ref.segIdx] = value;
			dirty.add(ref.rIdx);
		}
		for (const rIdx of dirty) rebuild(rIdx);
	};

	// What each rule matches, plus the descendants a removal there can reach. Computed once so
	// the bisection checks a removal against that subtree rather than the whole render, which
	// is what makes large components finish inside the budget. See oracle.subtreeTargets.
	const matched: Element[][] = rules.map((r) => {
		try {
			return Array.from(oracle.body.querySelectorAll(r.rule.selectorText));
		} catch {
			return [];
		}
	});
	const ruleTargets = matched.map((els) => oracle.subtreeTargets(els));
	const affectedTargets = (idxs: number[]): number[] => {
		const dirty = new Set<number>();
		for (const i of idxs) dirty.add(index[i]!.rIdx);
		const out = new Set<number>();
		for (const rIdx of dirty) for (const t of ruleTargets[rIdx]!) out.add(t);
		return [...out];
	};

	const deadline = now() + BUDGET_MS;
	const all = index.map((_, i) => i);

	// Delta-debugging bisection: remove a chunk, keep it removed if the affected subtree still
	// matches, otherwise restore and split. Every accepted removal leaves the frame equal to
	// the reference, so later checks compare against the same baseline.
	const bisect = (idxs: number[]): void => {
		if (idxs.length === 0 || now() > deadline) return;
		setKept(idxs, false);
		if (oracle.matchesSubset(affectedTargets(idxs))) return;
		setKept(idxs, true);
		if (idxs.length === 1) return; // A single declaration that changes the render is kept.
		const mid = Math.floor(idxs.length / 2);
		bisect(idxs.slice(0, mid));
		bisect(idxs.slice(mid));
	};

	// Pre-pass: batch the declarations most likely dead, those restating an inherited value or
	// a ua default, and try removing them in one check. A pass clears the whole batch at once,
	// the big win on large components; a fail bisects only the batch, still cheap because it
	// is nearly all removable. Either way the outcome is the same, only the check count moves.
	// The batch spans nearly every rule, so it is checked against the whole render.
	const batch = redundantDefaults(oracle, rules, index, matched, uaDefaults(oracle, matched, rules, index));
	const inBatch = new Set(batch);
	const rest = all.filter((i) => !inBatch.has(i));
	if (batch.length > 0) {
		setKept(batch, false);
		if (!oracle.matchesReference()) {
			setKept(batch, true);
			bisect(batch);
		}
	}
	bisect(rest);

	// Soundness fallback: the frame should equal the reference here, but if a pathological
	// cascade left it diverging, restore everything rather than ship a wrong render.
	if (!oracle.matchesReference()) {
		for (let rIdx = 0; rIdx < rules.length; rIdx++) {
			rules[rIdx]!.kept.fill(true);
			rebuild(rIdx);
		}
	}

	if (stats) {
		stats.declsAfter = index.filter((ref) => rules[ref.rIdx]!.kept[ref.segIdx]).length;
		stats.charsAfter = rules.reduce((sum, r) => sum + (r.rule.style.length > 0 ? r.rule.cssText.length : 0), 0);
	}
	return serializeRules(topRules);
}

/**
 * The pre-pass batch: candidates that, on every element their rule matches, already sit at the
 * value they would fall back to. Inherited means equal to the parent; non-inherited means
 * equal to the ua default for the tag. A rule matching nothing qualifies too, and a shorthand
 * reads as empty so it goes to the bisection.
 *
 * A guess only, since a value can equal the default and still be load-bearing over a
 * lower-cascade rule. The oracle verifies the batch, so a wrong guess costs a re-bisection.
 *
 * @param oracle - the mounted render, read only here
 */
function redundantDefaults(
	oracle: RenderOracle,
	rules: MinRule[],
	index: DeclRef[],
	matched: Element[][],
	defaults: Map<string, Map<string, string>>,
): number[] {
	const win = oracle.win;
	const out: number[] = [];
	for (let i = 0; i < index.length; i++) {
		const { rIdx, segIdx } = index[i]!;
		const els = matched[rIdx]!;
		if (els.length === 0) {
			out.push(i);
			continue;
		}
		const prop = rules[rIdx]!.segs[segIdx]!.prop;
		let redundant = true;
		for (const el of els) {
			const own = win.getComputedStyle(el).getPropertyValue(prop);
			// A shorthand reads as empty, so it cannot be judged here.
			if (own === '') {
				redundant = false;
				break;
			}
			const baseline = INHERITED.has(prop)
				? el.parentElement && win.getComputedStyle(el.parentElement).getPropertyValue(prop)
				: defaults.get(el.tagName)?.get(prop);
			if (baseline == null || own !== baseline) {
				redundant = false;
				break;
			}
		}
		if (redundant) out.push(i);
	}
	return out;
}

/**
 * The ua default of each non-inherited candidate property, per tag. It is read from a bare
 * element mounted transiently in the frame, so the value is the engine's own rather than a
 * table. That element is appended, read, and removed while no comparison is in flight.
 *
 * A layout property reads a context-dependent value on a bare element, so it never matches a
 * real one and never joins the batch. That is what keeps a risky size, such as a form
 * control's intrinsic height, out of the fast path and in the verified bisection.
 */
function uaDefaults(oracle: RenderOracle, matched: Element[][], rules: MinRule[], index: DeclRef[]): Map<string, Map<string, string>> {
	const props = new Set<string>();
	for (const { rIdx, segIdx } of index) {
		const prop = rules[rIdx]!.segs[segIdx]!.prop;
		if (!INHERITED.has(prop)) props.add(prop);
	}
	const tags = new Set<string>();
	for (const els of matched) for (const el of els) tags.add(el.tagName);

	const win = oracle.win;
	const doc = oracle.body.ownerDocument;
	const out = new Map<string, Map<string, string>>();
	for (const tag of tags) {
		let bare: Element;
		try {
			bare = doc.createElement(tag.toLowerCase());
		} catch {
			continue; // Not a creatable tag name, so its elements fall to the bisection.
		}
		oracle.body.appendChild(bare);
		const cs = win.getComputedStyle(bare);
		const values = new Map<string, string>();
		for (const prop of props) values.set(prop, cs.getPropertyValue(prop));
		out.set(tag, values);
		bare.remove();
	}
	return out;
}

/** Monotonic wall-clock reading for the budget, in milliseconds. */
function now(): number {
	return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}
