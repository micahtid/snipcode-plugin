/**
 * reconcile/probe.ts: the completeness instruments, measuring without mutating
 *
 * Pipeline position: reconcile, report mode. Nothing here mutates the capture.
 * Reads from Captured: root, clone, fonts, page.viewport
 * Writes to Captured: warnings only, when a probe cannot run
 *
 * Why this exists: the closing reconciliation fixes what it can, and these two probes say
 * what is left. probeStandalone diffs the intermediate inline clone against the live
 * original. probeEmitted diffs the artifact that actually ships, both against the live
 * original, giving the true residual, and against the inline clone, which isolates how
 * much of that residual the convert and emit step introduced. Both are deterministic, with
 * no screenshot anywhere, which is what makes them the signal the measurement loop gates on
 * before it trusts a pixel score.
 */
import type { Captured } from '../types';
import { pairedSubtrees, isInjected } from './match';
import { createSizedFrame, withStandaloneFrame, zip, type SizedFrame } from './frame';
import { comparableProps, isReplacedElement, MAX_SAMPLES, pathOf, shouldReclaim, topN, TOP_PROPS } from './diff';
import { probeUnresolvedFonts } from './probe-fonts';

/** The result of diffing the standalone clone against the live original. */
export interface StandaloneReport {
	/** Total property discrepancies across all paired elements. */
	droppedProps: number;
	/** Elements present in the original subtree but missing from the clone. */
	droppedEls: number;
	/**
	 * Web faces the live subtree renders that the standalone artifact cannot resolve. That
	 * means either a family absent from the artifact (a discovery gap), or a declared face
	 * whose bytes never load (an inlining gap). This is the resource-loss signal getComputedStyle is
	 * blind to, since both live and standalone report the same requested font string
	 * while only the live element actually paints it.
	 */
	unresolvedResources: number;
	/** The properties that diverge most often, for diagnosis, bounded. */
	topProps: Array<{ prop: string; count: number }>;
	/** A bounded sample of concrete discrepancies, for diagnosis. */
	samples: Array<{ path: string; prop: string; live: string; standalone: string }>;
}

/** One direction of the emitted-artifact diff: the count, the worst properties, samples. */
export interface EmittedDelta {
	/** Total property discrepancies across all paired elements in this direction. */
	droppedProps: number;
	/** The properties that diverge most often, for diagnosis, bounded. */
	topProps: Array<{ prop: string; count: number }>;
	/** A bounded sample of concrete discrepancies, for diagnosis. */
	samples: Array<{ path: string; prop: string; a: string; b: string }>;
}

/**
 * The result of the emitted-artifact probe. It diffs the shipped BEM artifact's render
 * against the live original, giving delta A, and against the inline-clone's standalone
 * render, giving delta B. It also carries the count of delta-A properties whose value
 * never reached the emitted CSS, the absent-at-bake subset, which is distinct from a
 * render-time cascade loss.
 */
export interface EmittedReport {
	/** Emitted standalone vs live original: the true shipped residual. */
	deltaA: EmittedDelta;
	/** Emitted standalone vs inline-clone standalone: the convert/emit cascade loss. */
	deltaB: EmittedDelta;
	/** The subset of delta-A discrepancies whose live value is absent from the emitted CSS. */
	absentProps: number;
}

/**
 * Reports the standalone-vs-live discrepancies without mutating anything. This is the
 * completeness instrument. It measures exactly what the artifact fails to reproduce,
 * independent of any live rendering. Alongside the computed-style diff it runs the
 * resource probe (probeUnresolvedFonts), which sees the layer below computed style that
 * the string compare cannot see, namely a web font the artifact declares but cannot load.
 *
 * @param captured - the reconciled capture (read-only here)
 */
export async function probeStandalone(captured: Captured): Promise<StandaloneReport> {
	const report: StandaloneReport = { droppedProps: 0, droppedEls: 0, unresolvedResources: 0, topProps: [], samples: [] };
	report.droppedEls = countDroppedElements(captured.root, captured.clone);
	const counts = new Map<string, number>();
	try {
		withStandaloneFrame(captured, (mapCloneToFrame, win) => {
			const pairs = pairedSubtrees(captured.root, captured.clone);
			for (const [original, clone] of pairs) {
				const framed = mapCloneToFrame.get(clone);
				if (!framed) continue;
				const live = getComputedStyle(original);
				const standalone = win.getComputedStyle(framed);
				const replaced = isReplacedElement(original);
				const targetColor = live.getPropertyValue('color');
				for (const prop of comparableProps(live)) {
					const liveVal = live.getPropertyValue(prop);
					const stdVal = standalone.getPropertyValue(prop);
					if (!shouldReclaim(prop, stdVal, liveVal, replaced, targetColor)) continue;
					report.droppedProps++;
					counts.set(prop, (counts.get(prop) ?? 0) + 1);
					if (report.samples.length < MAX_SAMPLES) {
						report.samples.push({ path: pathOf(captured.root, original), prop, live: liveVal, standalone: stdVal });
					}
				}
			}
		});
	} catch (err) {
		captured.warnings.push(`standalone probe: skipped (${(err as Error).message})`);
	}
	// Resource probe: detection only, isolated so a failure leaves the count at zero and
	// never pushes a warning, keeping the emitted artifact byte-identical.
	try {
		report.unresolvedResources = await probeUnresolvedFonts(captured);
	} catch {
		// FontFaceSet or frame unavailable, so the resource signal reads zero this run.
	}
	report.topProps = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_PROPS).map(([prop, count]) => ({ prop, count }));
	return report;
}

/**
 * The emitted-artifact probe. It renders the final BEM class-based artifact in an isolated
 * iframe and diffs each element's computed style against the live original, giving delta A,
 * and against the inline-clone's own standalone render, giving delta B. Where probeStandalone above
 * validates the intermediate inline clone, this validates the artifact that actually
 * ships, so it is the anchor the measurement loop gates on.
 *
 * delta B isolates the convert/emit cascade loss. clean.ts is verified lossless, so any
 * clone->emitted computed-style divergence is the BEM class cascade resolving differently
 * than the inline styles it replaced. delta A is the true shipped residual versus the live
 * element. absentProps counts the subset of delta A whose needed value never reached the
 * emitted CSS at all, an upstream capture/bake gap rather than a cascade defect. Both renders use
 * the same drift-free iframe as probeStandalone, so the probe is deterministic.
 *
 * @param captured - the reconciled capture (root + clone, read-only here)
 * @param emittedHtml - the emitted root markup, the emitBem output before doc assembly
 * @param emittedCss - the shipped stylesheet, after cleanCss
 */
export function probeEmitted(captured: Captured, emittedHtml: string, emittedCss: string): EmittedReport {
	const report: EmittedReport = {
		deltaA: { droppedProps: 0, topProps: [], samples: [] },
		deltaB: { droppedProps: 0, topProps: [], samples: [] },
		absentProps: 0,
	};
	const aCounts = new Map<string, number>();
	const bCounts = new Map<string, number>();
	let cloneSized: SizedFrame | null = null;
	let emittedSized: SizedFrame | null = null;
	try {
		// Render the inline clone and the emitted artifact in two separate frames, because
		// the emitted stylesheet must not match the clone's author classes, so they cannot
		// share a document. Both are the pasted-snip environment: ua stylesheet only.
		cloneSized = createSizedFrame(captured);
		const framedClone = cloneSized.doc.importNode(captured.clone, true) as Element;
		cloneSized.doc.body.appendChild(framedClone);

		emittedSized = createSizedFrame(captured);
		const styleEl = emittedSized.doc.createElement('style');
		styleEl.textContent = emittedCss;
		emittedSized.doc.head.appendChild(styleEl);
		const holder = emittedSized.doc.createElement('div');
		holder.innerHTML = emittedHtml;
		const emittedRoot = holder.firstElementChild;
		if (!emittedRoot) throw new Error('emitted markup has no root element');
		emittedSized.doc.body.appendChild(emittedRoot);

		// emitBem deep-copies the clone and only rewrites class/style attributes, never
		// adding or dropping elements, so the emitted tree is structurally identical to the
		// clone tree, and a lockstep zip pairs them. pairedSubtrees pairs the live original to
		// the clone, skipping clone-only injected nodes the original lacks.
		const cloneToFramed = new Map<Element, Element>();
		zip(captured.clone, framedClone, cloneToFramed);
		const cloneToEmitted = new Map<Element, Element>();
		zip(captured.clone, emittedRoot, cloneToEmitted);

		// delta B: every paired element, emitted standalone vs inline-clone standalone.
		for (const [clone, framed] of cloneToFramed) {
			const emitted = cloneToEmitted.get(clone);
			if (!emitted) continue;
			const cloneCs = cloneSized.win.getComputedStyle(framed);
			const emittedCs = emittedSized.win.getComputedStyle(emitted);
			const replaced = isReplacedElement(clone);
			const targetColor = cloneCs.getPropertyValue('color');
			for (const prop of comparableProps(cloneCs)) {
				const cloneVal = cloneCs.getPropertyValue(prop);
				const emittedVal = emittedCs.getPropertyValue(prop);
				if (!shouldReclaim(prop, emittedVal, cloneVal, replaced, targetColor)) continue;
				report.deltaB.droppedProps++;
				bCounts.set(prop, (bCounts.get(prop) ?? 0) + 1);
				if (report.deltaB.samples.length < MAX_SAMPLES) {
					report.deltaB.samples.push({ path: pathOf(captured.clone, clone), prop, a: cloneVal, b: emittedVal });
				}
			}
		}

		// delta A: every live original, live computed value vs emitted standalone. A value
		// the emitted CSS never carries is an absent-at-bake gap. One it carries but renders
		// differently is a render-time gap. The delta-B attribution says which mechanism.
		const cssHaystack = emittedCss.replace(/\s+/g, ' ').toLowerCase();
		for (const [original, clone] of pairedSubtrees(captured.root, captured.clone)) {
			const emitted = cloneToEmitted.get(clone);
			if (!emitted) continue;
			const live = getComputedStyle(original);
			const emittedCs = emittedSized.win.getComputedStyle(emitted);
			const replaced = isReplacedElement(original);
			const targetColor = live.getPropertyValue('color');
			for (const prop of comparableProps(live)) {
				const liveVal = live.getPropertyValue(prop);
				const emittedVal = emittedCs.getPropertyValue(prop);
				if (!shouldReclaim(prop, emittedVal, liveVal, replaced, targetColor)) continue;
				report.deltaA.droppedProps++;
				aCounts.set(prop, (aCounts.get(prop) ?? 0) + 1);
				if (!cssHaystack.includes(liveVal.replace(/\s+/g, ' ').toLowerCase())) report.absentProps++;
				if (report.deltaA.samples.length < MAX_SAMPLES) {
					report.deltaA.samples.push({ path: pathOf(captured.root, original), prop, a: liveVal, b: emittedVal });
				}
			}
		}
	} catch (err) {
		captured.warnings.push(`emitted probe: skipped (${(err as Error).message})`);
	} finally {
		cloneSized?.frame.remove();
		emittedSized?.frame.remove();
	}
	report.deltaA.topProps = topN(aCounts);
	report.deltaB.topProps = topN(bCounts);
	return report;
}

/**
 * Counts elements present in the original subtree but SILENTLY missing from the clone.
 * Walks both trees in lockstep, skipping clone-only injected nodes as pairedSubtrees
 * does. An original child the clone lacks at a given level is a drop, counted with its
 * whole subtree. Elements a handler removes deliberately, such as a `<picture>`'s `<source>`
 * overridden by the pinned `<img src>`, are not silent drops and do not count, so this
 * stays a true signal of unintended structural loss rather than intended pruning.
 *
 * @param root - the live snip root
 * @param clone - the working clone
 */
function countDroppedElements(root: Element, clone: Element): number {
	let dropped = 0;
	const walk = (o: Element, c: Element): void => {
		const oKids = Array.from(o.children).filter((ch) => !isIntentionallyRemoved(ch));
		const cKids = Array.from(c.children).filter((ch) => !isInjected(ch));
		const n = Math.min(oKids.length, cKids.length);
		for (let i = 0; i < n; i++) {
			const ok = oKids[i];
			const ck = cKids[i];
			if (ok && ck) walk(ok, ck);
		}
		for (let i = n; i < oKids.length; i++) {
			const ok = oKids[i];
			if (ok) dropped += 1 + ok.querySelectorAll('*').length;
		}
	};
	walk(root, clone);
	return dropped;
}

/** True for an original element a handler removes by design, so its absence is not a drop. */
function isIntentionallyRemoved(el: Element): boolean {
	// images.ts removes <source> inside <picture> once the <img> is pinned to currentSrc.
	return el.tagName === 'SOURCE' && el.parentElement?.tagName === 'PICTURE';
}
