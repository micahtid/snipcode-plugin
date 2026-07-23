/**
 * reconcile/frame.ts: the pasted-snip environment, as an iframe
 *
 * Pipeline position: reconcile, a helper shared with minimize
 * Reads from Captured: clone, page.viewport
 * Writes to Captured: nothing
 *
 * Why this exists: every claim the closing reconciliation and the probes make rests on one
 * idea, that the artifact's own render is the authority. That render needs an environment
 * with the page's author rules absent and nothing but the ua stylesheet present, which is
 * exactly what a fresh about:blank iframe is. Defining it once here means the reconcile
 * probes and the minimize oracle judge against the same environment rather than two
 * subtly different ones.
 */
import type { Captured } from '../types';

/** A hidden iframe and its document/window, sized to the capture viewport. */
export interface SizedFrame {
	frame: HTMLIFrameElement;
	doc: Document;
	win: Window;
}

/**
 * Creates a fresh, hidden, same-origin iframe sized to the capture viewport, with the
 * iframe's own ua margins zeroed so a mounted root lays out from 0,0. about:blank
 * carries only the ua stylesheet, so the page's author rules are absent, exactly the
 * pasted-snip environment. The caller mounts content into `doc.body` and must call
 * `frame.remove()` when done, since both standalone renders the loop compares are built on it.
 *
 * Exported so the minimize phase mounts its oracle in the same pasted-snip environment,
 * keeping one authoritative definition of what a standalone frame is.
 *
 * With standards true the frame is switched to standards mode by writing a doctype,
 * because a fresh iframe's about:blank is in quirks mode, where form-control box-sizing
 * and other layout differ from the shipped artifact, which always carries a doctype. The
 * minimize oracle needs that match so a removal's rendered effect is judged as it ships.
 * The reconcile probes keep the default, preserving their established behavior.
 *
 * @param captured - source of the viewport size
 * @param standards - write a doctype so the frame renders in standards mode
 */
export function createSizedFrame(captured: Captured, standards = false): SizedFrame {
	const vw = captured.page.viewport.width || 1280;
	const vh = captured.page.viewport.height || 800;
	const frame = document.createElement('iframe');
	frame.setAttribute('aria-hidden', 'true');
	// Off-screen but sized to the capture viewport so vw/vh/% resolve as they would
	// in the pasted snip. visibility:hidden keeps it from painting.
	frame.style.cssText = `position:absolute;left:-99999px;top:0;width:${vw}px;height:${vh}px;border:0;visibility:hidden`;
	document.body.appendChild(frame);
	const doc = frame.contentDocument;
	const win = frame.contentWindow;
	if (!doc || !win) {
		frame.remove();
		throw new Error('standalone iframe unavailable');
	}
	if (standards) {
		doc.open();
		doc.write('<!DOCTYPE html><html><head></head><body></body></html>');
		doc.close();
	}
	doc.documentElement.style.margin = '0';
	doc.body.style.margin = '0';
	return { frame, doc, win: win as unknown as Window };
}

/**
 * Mounts a deep copy of the working clone in a fresh, hidden, same-origin iframe
 * sized to the capture viewport, where about:blank carries only the ua stylesheet so the
 * page's author rules are absent, exactly the pasted-snip environment. Builds a map
 * from each working-clone element to its in-frame counterpart, and since the two trees are
 * structurally identical a lockstep walk pairs them, then runs `fn` with that
 * map while the frame is attached and laid out, tearing it down afterward.
 *
 * @param captured - source of the clone and the viewport size
 * @param fn - reads standalone computed styles via the clone->frame element map
 */
export function withStandaloneFrame(captured: Captured, fn: (map: Map<Element, Element>, win: Window) => void): void {
	const sized = createSizedFrame(captured);
	try {
		const framedRoot = sized.doc.importNode(captured.clone, true) as Element;
		sized.doc.body.appendChild(framedRoot);
		const map = new Map<Element, Element>();
		zip(captured.clone, framedRoot, map);
		fn(map, sized.win);
	} finally {
		sized.frame.remove();
	}
}

/**
 * Walks two structurally-identical trees in lockstep, recording clone->copy pairs.
 * The frame copy is a deep importNode of the clone, so children align by index.
 *
 * @param clone - a working-clone element
 * @param framed - its in-frame counterpart
 * @param map - accumulates the element correspondence
 */
export function zip(clone: Element, framed: Element, map: Map<Element, Element>): void {
	map.set(clone, framed);
	const a = clone.children;
	const b = framed.children;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const ca = a[i];
		const cb = b[i];
		if (ca && cb) zip(ca, cb, map);
	}
}
