/**
 * core/src/host.ts: the port boundary.
 *
 * The extension content code reached four privileged services through
 * chrome.runtime messages to a background worker: the devtools protocol
 * (inherited cascade, cross-origin sheet text, forced interactive states),
 * cross-origin asset fetch, and (in the extension) screenshots.
 *
 * core/ must not know whether it runs inside a chrome extension or a headless
 * Playwright page, so those services are abstracted behind this one Host
 * interface. The runner installs an implementation, in-page core calls it. This
 * is the only seam between core/ and its host, which is what keeps core/
 * promotable to a shared @snipcode/core package with no plugin-specific code.
 *
 * The wire shape mirrors the original background envelope ({ ok, result, error })
 * so the ported capture code reads replies exactly as it did against chrome.
 */

/** One authored ancestor rule the host lifted from CSS.getMatchedStylesForNode.inherited. */
export interface CdpRule {
	selector: string;
	properties: Record<string, string>;
	media?: string;
}

/** Reply to cdpInherited: the authored inherited cascade plus a closed-shadow count. */
export interface CdpInheritedResult {
	inherited: CdpRule[];
	closedShadowRoots: number;
	warning?: string;
}

/** The background reply envelope, preserved so ported call sites read replies unchanged. */
export interface Envelope<T> {
	ok: boolean;
	result?: T;
	error?: { code?: string; message: string };
}

/**
 * The four privileged services core/ depends on. Every method is async because
 * the real implementation round-trips out of the page to the Node runner.
 */
export interface Host {
	/** Authored inherited cascade for the node matched by selector, via the devtools protocol. */
	cdpInherited(selector: string): Promise<Envelope<CdpInheritedResult>>;
	/** Privileged re-fetch of a cross-origin stylesheet the page context could not read. */
	fetchStylesheet(href: string): Promise<Envelope<{ text: string; mimeType: string }>>;
	/** Cross-origin stylesheet text read straight from the protocol, no network round-trip. */
	cdpStylesheets(hrefs: string[]): Promise<Envelope<{ sheets: Array<{ href: string; text: string }> }>>;
	/** Cross-origin asset fetched and returned as a base64 data uri. */
	fetchBinary(url: string): Promise<Envelope<{ dataUrl: string }>>;
	/** Open a forced-state session: attach the protocol and hold it across many forceState calls. */
	forceBegin(): Promise<Envelope<{ began: boolean }>>;
	/** Force (or, with an empty list, clear) pseudo-states on the node matched by selector. */
	forceState(selector: string, states: string[]): Promise<Envelope<{ found: boolean }>>;
	/** Close the forced-state session, detaching the protocol so every forced state clears. */
	forceEnd(): Promise<void>;
}

/**
 * The runner exposes exactly one Node function on the page, __snipHostSend, that
 * brokers a (type, payload) pair to the privileged implementation and resolves
 * with the envelope. Keeping it to one exposed binding, rather than one per
 * service, means the runner sets up the seam in a single call.
 */
type Send = (type: string, payload: unknown) => Promise<unknown>;

function sender(): Send {
	const fn = (globalThis as unknown as { __snipHostSend?: Send }).__snipHostSend;
	if (typeof fn !== 'function') {
		throw new Error('snip host not installed: __snipHostSend missing from page');
	}
	return fn;
}

/** The in-page Host adapter. Each typed method funnels through the one exposed binding. */
const pageHost: Host = {
	cdpInherited: (selector) => sender()('CDP_INHERITED', { selector }) as Promise<Envelope<CdpInheritedResult>>,
	fetchStylesheet: (href) => sender()('FETCH_STYLESHEET', { href }) as Promise<Envelope<{ text: string; mimeType: string }>>,
	cdpStylesheets: (hrefs) => sender()('CDP_STYLESHEETS', { hrefs }) as Promise<Envelope<{ sheets: Array<{ href: string; text: string }> }>>,
	fetchBinary: (url) => sender()('FETCH_BINARY', { url }) as Promise<Envelope<{ dataUrl: string }>>,
	forceBegin: () => sender()('CDP_FORCE_BEGIN', {}) as Promise<Envelope<{ began: boolean }>>,
	forceState: (selector, states) => sender()('CDP_FORCE_STATE', { selector, states }) as Promise<Envelope<{ found: boolean }>>,
	forceEnd: () => sender()('CDP_FORCE_END', {}).then(() => undefined),
};

let active: Host = pageHost;

/** The host every capture module calls. Defaults to the in-page adapter over __snipHostSend. */
export function getHost(): Host {
	return active;
}

/** Swap the host, for tests that want to stub the privileged services. */
export function setHost(host: Host): void {
	active = host;
}
