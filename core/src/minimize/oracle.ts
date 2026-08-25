/**
 * minimize/oracle.ts: the render check every minimize phase proposes edits to.
 *
 * Mounts the emitted markup and stylesheet in a hidden, viewport-sized iframe carrying only
 * the ua stylesheet, the environment reconcile/standalone.ts also validates against. It
 * snapshots getComputedStyle for every element and its ::before/::after, then re-reads and
 * compares after a candidate edit.
 *
 * Equal computed styles on an unchanged dom mean an identical render. Accepting only edits
 * that leave every longhand alone therefore errs one way: it can keep a dead declaration,
 * never delete a live one.
 *
 * Two details make the verdict trustworthy. It enumerates the longhands the engine reports
 * rather than a fixed list, and compares before against after inside one frame. Any difference
 * is then the edit rather than the standalone context. And the cycle is synchronous, so the
 * frame never yields to load a font or run a timer mid-run.
 */
import type { Captured } from '../types';
import { createSizedFrame } from '../reconcile/frame';

/** One computed-style target: an element box, or one of its generated pseudo boxes. */
interface Target {
	el: Element;
	/** '' for the element box, '::before'/'::after' for a generated box. */
	pseudo: string;
}

/**
 * A mounted render whose computed styles can be snapshotted and re-compared after an edit
 * to `sheet`. Created by createRenderOracle, disposed by the caller.
 */
export interface RenderOracle {
	/** The live stylesheet the frame renders from. The minimizer mutates its rules. */
	readonly sheet: CSSStyleSheet;
	/** The frame window, for reading computed styles of the mounted elements. */
	readonly win: Window;
	/** The frame body holding the mounted markup, for selecting the elements a rule matches. */
	readonly body: Element;
	/** Snapshots the current render as the reference every later edit is judged against. */
	captureReference(): void;
	/** Whether the current render's computed styles match the captured reference exactly. */
	matchesReference(): boolean;
	/**
	 * Whether the given targets still match the reference, the rest of the tree assumed
	 * unchanged. Sound only when the caller passes every target a removal could touch (see
	 * subtreeTargets). This is the fast path the bisection uses.
	 */
	matchesSubset(targetIdxs: number[]): boolean;
	/**
	 * The target indices covering these elements and all their descendants, pseudos included.
	 * A removal can only change the elements a rule matches and what they contain, by
	 * inheritance or containing-block sizing. A shift on an ancestor or sibling follows a size
	 * change on one of these, which is caught on that element first.
	 */
	subtreeTargets(elements: Element[]): number[];
	/** Tears down the iframe. */
	dispose(): void;
}

/**
 * Mounts the emitted markup and stylesheet in an isolated, viewport-sized frame and returns
 * an oracle over that render. Throws when the frame or its stylesheet will not come up, which
 * the caller treats as infrastructure failure and skips the phase.
 *
 * It awaits the frame's fonts first, so its metrics match the shipped render, which also
 * waits for fonts. Without that a font-dependent size, such as a control's intrinsic height,
 * computes differently here than it ships and a removal that shifts it looks clean. The faces
 * come from the stylesheet's inlined data-uris, so this settles without the network.
 *
 * @param css - the emitted stylesheet, mounted whole so the render context is complete
 */
export async function createRenderOracle(captured: Captured, css: string, markup: string): Promise<RenderOracle> {
	const sized = createSizedFrame(captured, true);
	let sheet: CSSStyleSheet;
	let styleEl: HTMLStyleElement;
	try {
		styleEl = sized.doc.createElement('style');
		styleEl.textContent = css;
		sized.doc.head.appendChild(styleEl);
		if (!styleEl.sheet) throw new Error('stylesheet did not attach');
		sheet = styleEl.sheet;
		sized.doc.body.innerHTML = markup;
		// Freeze motion so no computed value is time-dependent. A running animation, or a
		// transition a candidate removal fires, makes getComputedStyle return a mid-flight
		// value and the before/after comparison accepts a removal still animating in. The
		// freeze is the oracle's own and never reaches the output; prune.ts keeps motion
		// declarations out of removal anyway.
		//
		// Inline styles, not just a stylesheet rule. A `*{...!important}` rule loses to any
		// author rule with a more specific `!important` selector, such as the measured
		// `[data-snip-state] { transition: all !important }`. Inline important outranks every
		// selector rule. The stylesheet rule still covers the pseudo boxes, which cannot carry
		// an inline style.
		const pseudoFreeze = sized.doc.createElement('style');
		pseudoFreeze.textContent = '*::before,*::after{animation:none!important;transition:none!important}';
		sized.doc.head.appendChild(pseudoFreeze);
		for (const el of Array.from(sized.doc.body.querySelectorAll('*'))) {
			(el as HTMLElement).style.setProperty('animation', 'none', 'important');
			(el as HTMLElement).style.setProperty('transition', 'none', 'important');
		}
	} catch (err) {
		sized.frame.remove();
		throw err instanceof Error ? err : new Error(String(err));
	}

	const win = sized.win;
	// Settle the frame's fonts before reading any metric, bounded so a face that never
	// resolves cannot hang the phase. fonts.ready settles on failure too, so the timeout
	// guards only a pathological pending load.
	try {
		await Promise.race([
			win.document.fonts.ready,
			new Promise<void>((resolve) => win.setTimeout(resolve, 2000)),
		]);
	} catch {
		// FontFaceSet unavailable, so proceed with whatever metrics the frame reports.
	}
	// Every element box, plus a pseudo box only where it renders content. A painting pseudo
	// has to be compared, because it inherits from the element: deleting the element's color
	// can change the pseudo while the element box holds still. A pseudo with no content
	// generates no box and no deletion can give it one, so skipping it is safe and drops most
	// of the pseudo targets. The dom never changes during minimization, so this list is stable.
	const targets: Target[] = [];
	// Element to its own target indices, so a subtree maps to the exact targets to re-check.
	const elToTargets = new Map<Element, number[]>();
	for (const el of Array.from(sized.doc.body.querySelectorAll('*'))) {
		const idxs: number[] = [];
		idxs.push(targets.push({ el, pseudo: '' }) - 1);
		for (const pseudo of ['::before', '::after']) {
			if (win.getComputedStyle(el, pseudo).content !== 'none') idxs.push(targets.push({ el, pseudo }) - 1);
		}
		elToTargets.set(el, idxs);
	}

	// The master property list, read once and shared by every snapshot: the longhands
	// getComputedStyle enumerates, plus every property the stylesheet declares. The union
	// matters because getComputedStyle skips some non-standard properties that still paint,
	// such as -webkit-font-smoothing. Deleting one of those would shift the render with no
	// visible computed-style change. getPropertyValue reads them anyway, and a shorthand reads
	// as empty in both snapshots, so the extras cost nothing. Empty when nothing mounted.
	const masterProps: string[] = [];
	const seenProp = new Set<string>();
	if (targets.length > 0) {
		const cs = win.getComputedStyle(targets[0]!.el);
		for (let i = 0; i < cs.length; i++) {
			const prop = cs.item(i);
			if (prop && !seenProp.has(prop)) {
				seenProp.add(prop);
				masterProps.push(prop);
			}
		}
		for (const rule of Array.from(sheet.cssRules)) {
			if (rule.type !== CSSRule.STYLE_RULE) continue;
			const style = (rule as CSSStyleRule).style;
			for (let i = 0; i < style.length; i++) {
				const prop = style[i];
				if (prop && !prop.startsWith('--') && !seenProp.has(prop)) {
					seenProp.add(prop);
					masterProps.push(prop);
				}
			}
		}
	}

	const propIndex = new Map<string, number>();
	masterProps.forEach((prop, i) => propIndex.set(prop, i));

	let reference: string[][] | null = null;
	// Per-target prop indices left out of the comparison because they paint nothing here, so a
	// removal can change them freely. Computed once from the reference (see paintIrrelevant).
	let skips: Set<number>[] = [];

	const readTarget = (t: Target): CSSStyleDeclaration =>
		win.getComputedStyle(t.el, t.pseudo || undefined);

	return {
		get sheet() {
			return sheet;
		},
		get win() {
			return win;
		},
		get body() {
			return sized.doc.body;
		},
		captureReference() {
			reference = targets.map((t) => {
				const cs = readTarget(t);
				return masterProps.map((prop) => cs.getPropertyValue(prop));
			});
			skips = reference.map((values) => paintIrrelevant(values, propIndex));
		},
		matchesReference() {
			for (let ti = 0; ti < targets.length; ti++) if (!targetMatches(ti)) return false;
			return reference !== null;
		},
		matchesSubset(targetIdxs: number[]) {
			if (!reference) return false;
			for (const ti of targetIdxs) if (!targetMatches(ti)) return false;
			return true;
		},
		subtreeTargets(elements: Element[]) {
			const out = new Set<number>();
			for (const el of elements) {
				for (const idx of elToTargets.get(el) ?? []) out.add(idx);
				for (const d of Array.from(el.querySelectorAll('*'))) {
					for (const idx of elToTargets.get(d) ?? []) out.add(idx);
				}
			}
			return [...out];
		},
		dispose() {
			sized.frame.remove();
		},
	};

	/**
	 * Whether one target still matches the reference, skipping the paint-irrelevant properties.
	 * Exact string equality is the safest test: a true no-op leaves every value identical.
	 */
	function targetMatches(ti: number): boolean {
		if (!reference) return false;
		const cs = readTarget(targets[ti]!);
		const ref = reference[ti]!;
		const skip = skips[ti]!;
		for (let pi = 0; pi < masterProps.length; pi++) {
			if (skip.has(pi)) continue;
			if (cs.getPropertyValue(masterProps[pi]!) !== ref[pi]) return false;
		}
		return true;
	}
}

/**
 * Mounts a render oracle, runs a minimize phase's transform against it, and always tears the
 * frame down. Every phase shares this scaffold.
 *
 * On any infrastructure failure it appends `<skipLabel> (<cause>)` and ships the input css
 * unchanged, so a snip never fails on a minimize step. A phase with a cheap precondition of
 * its own checks that first, to avoid mounting a frame it does not need.
 *
 * @param captured - source of the viewport size. The skip warning is appended here.
 * @returns the transform's result, or the input css unchanged on any failure
 */
export async function withOracle(
	css: string,
	captured: Captured,
	markup: string,
	skipLabel: string,
	transform: (oracle: RenderOracle) => string,
): Promise<string> {
	if (!css.trim() || !markup.trim()) return css;
	let oracle: RenderOracle;
	try {
		oracle = await createRenderOracle(captured, css, markup);
	} catch (err) {
		captured.warnings.push(`${skipLabel} (${(err as Error).message})`);
		return css;
	}
	try {
		return transform(oracle);
	} catch (err) {
		captured.warnings.push(`${skipLabel} (${(err as Error).message})`);
		return css;
	} finally {
		oracle.dispose();
	}
}

/**
 * The prop indices that paint nothing in the reference render, so a removal changing only
 * those is render-neutral even though the computed value moved. This is what closes the gap
 * between a strict computed-style comparison and what a viewer actually sees.
 *
 * Several paint nothing at all. A zero-width border side, an outline or column rule with style
 * none, a text-emphasis with style none, a text-decoration-line of none, a zero-width text
 * stroke. Their color, style, width, and thickness stop mattering. text-fill-color stays
 * compared, since it paints the glyph body at rest.
 *
 * Two are conditional in a different way. caret-color paints only in a focused editable
 * field, so it is skipped where it equals color and kept where it differs, judged per target.
 * -webkit-tap-highlight-color paints only a mobile tap flash and is skipped outright: the one
 * deliberate trade here, taken openly rather than slipped through.
 *
 * Every relaxation is read from the reference alone, and none of the skipped properties
 * affects layout. A removal that instead makes a property start painting moves a gating
 * property, which is never skipped, so the comparison still catches it.
 */
function paintIrrelevant(values: string[], propIndex: Map<string, number>): Set<number> {
	const skip = new Set<number>();
	const mark = (prop: string): void => {
		const i = propIndex.get(prop);
		if (i !== undefined) skip.add(i);
	};
	for (const side of ['top', 'right', 'bottom', 'left']) {
		const wi = propIndex.get(`border-${side}-width`);
		if (wi !== undefined && parseFloat(values[wi]!) === 0) {
			mark(`border-${side}-color`);
			mark(`border-${side}-style`);
		}
	}
	const osi = propIndex.get('outline-style');
	if (osi !== undefined && values[osi] === 'none') {
		mark('outline-color');
		mark('outline-width');
	}
	const tes = propIndex.get('text-emphasis-style');
	if (tes !== undefined && values[tes] === 'none') mark('text-emphasis-color');
	const ci = propIndex.get('color');
	const cci = propIndex.get('caret-color');
	if (ci !== undefined && cci !== undefined && values[cci] === values[ci]) mark('caret-color');
	const tdl = propIndex.get('text-decoration-line');
	if (tdl !== undefined && values[tdl] === 'none') {
		mark('text-decoration-color');
		mark('text-decoration-style');
		mark('text-decoration-thickness');
	}
	const tsw = propIndex.get('-webkit-text-stroke-width');
	if (tsw !== undefined && parseFloat(values[tsw]!) === 0) mark('-webkit-text-stroke-color');
	const crs = propIndex.get('column-rule-style');
	if (crs !== undefined && values[crs] === 'none') {
		mark('column-rule-color');
		mark('column-rule-width');
	}
	mark('-webkit-tap-highlight-color');
	return skip;
}
