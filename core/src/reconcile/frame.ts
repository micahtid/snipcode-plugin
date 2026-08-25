/**
 * reconcile/frame.ts: the pasted-snip environment, as an iframe.
 *
 * Every claim the closing reconciliation and the minimize oracle make rests on the artifact's
 * own render being the authority. That needs the page's author rules absent and nothing but
 * the ua stylesheet present, which is a fresh about:blank iframe. Defined once here, so both
 * judge against the same environment rather than two subtly different ones.
 */
import type { Captured } from '../types';

/** A hidden iframe and its document/window, sized to the capture viewport. */
export interface SizedFrame {
	frame: HTMLIFrameElement;
	doc: Document;
	win: Window;
}

/** Off-screen and non-painting, so a frame lays out without ever reaching the screen. */
function hiddenFrameCss(width: number, height: number): string {
	return `position:absolute;left:-99999px;top:0;width:${width}px;height:${height}px;border:0;visibility:hidden`;
}

/**
 * Runs `fn` against a fresh, hidden, same-origin iframe of no size, tearing it down after.
 *
 * This is the probe form: about:blank carries only the ua stylesheet, so a value read here is
 * the engine's own default rather than anything the page declared. Size is zero because a probe
 * reads computed values and never needs vw/vh to resolve; createSizedFrame is the other form.
 *
 * @param sandbox - lay markup out but never run its scripts, for a frame given foreign html
 */
export function withProbeFrame<T>(fn: (doc: Document, win: Window) => T, sandbox = false): T {
	const frame = document.createElement('iframe');
	frame.setAttribute('aria-hidden', 'true');
	if (sandbox) frame.setAttribute('sandbox', 'allow-same-origin');
	frame.style.cssText = hiddenFrameCss(0, 0);
	document.body.appendChild(frame);
	try {
		const doc = frame.contentDocument;
		const win = frame.contentWindow;
		if (!doc || !win) throw new Error('probe iframe unavailable');
		return fn(doc, win as unknown as Window);
	} finally {
		frame.remove();
	}
}

/**
 * A hidden, same-origin iframe sized to the capture viewport, with its own ua margins zeroed
 * so a mounted root lays out from 0,0. The caller mounts into `doc.body` and must call
 * `frame.remove()` when done. Exported so the minimize oracle mounts in this same environment.
 *
 * With standards true a doctype is written, because a fresh about:blank is in quirks mode,
 * where form-control box-sizing differs from the shipped artifact. The oracle needs that match
 * to judge a removal as it ships; the reconcile probes keep the default.
 *
 * @param standards - write a doctype so the frame renders in standards mode
 */
export function createSizedFrame(captured: Captured, standards = false): SizedFrame {
	const vw = captured.page.viewport.width || 1280;
	const vh = captured.page.viewport.height || 800;
	const frame = document.createElement('iframe');
	frame.setAttribute('aria-hidden', 'true');
	// Sized to the capture viewport so vw/vh/% resolve as they would in the pasted snip.
	frame.style.cssText = hiddenFrameCss(vw, vh);
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
 * Mounts a deep copy of the working clone in a sized frame and pairs each clone element with
 * its in-frame counterpart by a lockstep walk. `fn` then runs with that map, while the frame
 * is attached and laid out.
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
 * Walks two structurally identical trees in lockstep, recording clone to copy pairs. The frame
 * copy is a deep importNode of the clone, so children align by index.
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
