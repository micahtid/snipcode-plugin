/**
 * runner/src/host.ts: the Node side of the port boundary.
 *
 * core/ runs in the page and reaches its four privileged services through one
 * exposed function, __snipHostSend(type, payload). This module implements those
 * services against a Playwright CDPSession and Node fetch, mirroring exactly what
 * the extension's background worker did with chrome.debugger and background fetch
 * (see the message contract in core/src/host.ts). The reply envelope shape
 * ({ ok, result, error }) is preserved so the ported capture code reads replies
 * unchanged.
 *
 * CDP lifecycle note: the extension attached and detached the debugger per one-shot
 * call and cleared forced states by detaching. Playwright holds one long-lived
 * session, so this module enables DOM/CSS once, buffers CSS.styleSheetAdded from the
 * start, and clears forced pseudo-states explicitly on forceEnd rather than by
 * detaching.
 */
import type { CDPSession, Page } from 'playwright';

/** Largest asset inlined as a data uri, matching the extension's 3 MB ceiling. */
const MAX_INLINE_BYTES = 3 * 1024 * 1024;
/** Poll budget for CDP_STYLESHEETS to let a requested sheet's styleSheetAdded arrive. */
const SHEET_POLL_STEPS = 20;
const SHEET_POLL_MS = 25;

interface Envelope<T> {
	ok: boolean;
	result?: T;
	error?: { code?: string; message: string };
}

function ok<T>(result: T): Envelope<T> {
	return { ok: true, result };
}
function fail(message: string, code?: string): Envelope<never> {
	return code ? { ok: false, error: { code, message } } : { ok: false, error: { message } };
}

/** A CSS.styleSheetAdded header, the fields this module reads. */
interface StyleSheetHeader {
	styleSheetId: string;
	sourceURL: string;
}

/**
 * Brokers the four privileged services for one page over a single CDPSession. One
 * instance per page; install() wires it to the page as __snipHostSend.
 */
export class PlaywrightHost {
	private cdp: CDPSession | null = null;
	private domainsReady = false;
	private readonly sheetHeaders: StyleSheetHeader[] = [];
	private forceRootNodeId: number | null = null;
	private readonly forcedNodes = new Set<number>();

	constructor(private readonly page: Page) {}

	/** Exposes __snipHostSend on the page so the injected core can reach this broker. */
	async install(): Promise<void> {
		await this.page.exposeFunction('__snipHostSend', (type: string, payload: unknown) => this.send(type, payload));
	}

	/** Routes one (type, payload) message to its handler, returning the reply envelope. */
	private async send(type: string, payload: unknown): Promise<Envelope<unknown>> {
		const p = (payload ?? {}) as Record<string, unknown>;
		try {
			switch (type) {
				case 'CDP_INHERITED':
					return await this.cdpInherited(String(p['selector']));
				case 'FETCH_STYLESHEET':
					return await this.fetchStylesheet(String(p['href']));
				case 'CDP_STYLESHEETS':
					return await this.cdpStylesheets((p['hrefs'] as string[]) ?? []);
				case 'FETCH_BINARY':
					return await this.fetchBinary(String(p['url']));
				case 'CDP_FORCE_BEGIN':
					return await this.forceBegin();
				case 'CDP_FORCE_STATE':
					return await this.forceState(String(p['selector']), (p['states'] as string[]) ?? []);
				case 'CDP_FORCE_END':
					return await this.forceEnd();
				default:
					return fail(`unknown host message: ${type}`, 'UNKNOWN_MESSAGE');
			}
		} catch (err) {
			return fail((err as Error).message);
		}
	}

	/** Lazily create the CDP session, enable DOM/CSS, and start buffering stylesheet headers. */
	private async session(): Promise<CDPSession> {
		if (this.cdp) return this.cdp;
		const cdp = await this.page.context().newCDPSession(this.page);
		cdp.on('CSS.styleSheetAdded', (params: { header: StyleSheetHeader }) => {
			if (params.header?.sourceURL) this.sheetHeaders.push(params.header);
		});
		this.cdp = cdp;
		return cdp;
	}

	/** Enable DOM then CSS once; CSS.enable replays styleSheetAdded for already-loaded sheets. */
	private async ensureDomains(): Promise<CDPSession> {
		const cdp = await this.session();
		if (!this.domainsReady) {
			await cdp.send('DOM.enable');
			await cdp.send('CSS.enable');
			this.domainsReady = true;
		}
		return cdp;
	}

	/** Authored inherited cascade for the node matched by selector. */
	private async cdpInherited(selector: string): Promise<Envelope<{ inherited: unknown[]; closedShadowRoots: number }>> {
		const cdp = await this.ensureDomains();
		const doc = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode };
		const closedShadowRoots = countClosedShadowRoots(doc.root);
		const found = (await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector })) as { nodeId?: number };
		if (!found.nodeId) return fail('target node not found via cdp', 'NODE_NOT_FOUND');
		const matched = (await cdp.send('CSS.getMatchedStylesForNode', { nodeId: found.nodeId })) as MatchedStyles;
		const inherited: CdpRule[] = [];
		for (const entry of matched.inherited ?? []) {
			for (const rm of entry.matchedCSSRules ?? []) {
				const rule = stripCdpRule(rm);
				if (rule) inherited.push(rule);
			}
		}
		return ok({ inherited, closedShadowRoots });
	}

	/** Privileged re-fetch of a cross-origin stylesheet. */
	private async fetchStylesheet(href: string): Promise<Envelope<{ text: string; mimeType: string }>> {
		const url = new URL(href);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail('unsupported protocol', 'BAD_PROTOCOL');
		const res = await fetch(href);
		if (!res.ok) return fail(`http ${res.status}`, 'CORS_BLOCKED');
		const text = await res.text();
		const mimeType = res.headers.get('content-type') ?? 'text/css';
		return ok({ text, mimeType });
	}

	/** Cross-origin stylesheet text read straight from the protocol, no network round-trip. */
	private async cdpStylesheets(hrefs: string[]): Promise<Envelope<{ sheets: Array<{ href: string; text: string }> }>> {
		const wanted = new Set(hrefs);
		if (wanted.size === 0) return ok({ sheets: [] });
		const cdp = await this.ensureDomains();
		// Poll until every wanted href has surfaced as a buffered header, or the budget runs out.
		for (let i = 0; i < SHEET_POLL_STEPS; i++) {
			const have = new Set(this.sheetHeaders.map((h) => h.sourceURL));
			if ([...wanted].every((href) => have.has(href))) break;
			await new Promise((r) => setTimeout(r, SHEET_POLL_MS));
		}
		const sheets: Array<{ href: string; text: string }> = [];
		const seen = new Set<string>();
		for (const header of this.sheetHeaders) {
			if (!wanted.has(header.sourceURL) || seen.has(header.styleSheetId)) continue;
			seen.add(header.styleSheetId);
			try {
				const res = (await cdp.send('CSS.getStyleSheetText', { styleSheetId: header.styleSheetId })) as { text?: string };
				if (res.text) sheets.push({ href: header.sourceURL, text: res.text });
			} catch {
				// A sheet whose text the protocol will not return is skipped, not fatal.
			}
		}
		return ok({ sheets });
	}

	/** Cross-origin asset fetched and returned as a base64 data uri. */
	private async fetchBinary(rawUrl: string): Promise<Envelope<{ dataUrl: string }>> {
		const url = new URL(rawUrl);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail('unsupported protocol', 'BAD_PROTOCOL');
		const res = await fetch(rawUrl);
		if (!res.ok) return fail(`http ${res.status}`, 'CORS_BLOCKED');
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.byteLength > MAX_INLINE_BYTES) return fail('too large', 'TOO_LARGE');
		const mime = (res.headers.get('content-type') ?? mimeFromUrl(url.pathname) ?? 'application/octet-stream').split(';')[0]!.trim();
		return ok({ dataUrl: `data:${mime};base64,${buf.toString('base64')}` });
	}

	/** Open the forced-state session: enable domains, pin motion, snapshot the document root. */
	private async forceBegin(): Promise<Envelope<{ began: boolean }>> {
		const cdp = await this.ensureDomains();
		try {
			await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
		} catch {
			// Best-effort: some targets refuse emulated media, which only affects motion pinning.
		}
		const doc = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode };
		this.forceRootNodeId = doc.root.nodeId;
		this.forcedNodes.clear();
		return ok({ began: true });
	}

	/** Force (or, with an empty list, clear) pseudo-states on the node matched by selector. */
	private async forceState(selector: string, states: string[]): Promise<Envelope<{ found: boolean }>> {
		if (this.forceRootNodeId == null) return fail('force session not begun', 'NO_SESSION');
		const cdp = await this.session();
		const found = (await cdp.send('DOM.querySelector', { nodeId: this.forceRootNodeId, selector })) as { nodeId?: number };
		if (!found.nodeId) return ok({ found: false });
		await cdp.send('CSS.forcePseudoState', { nodeId: found.nodeId, forcedPseudoClasses: states });
		if (states.length) this.forcedNodes.add(found.nodeId);
		else this.forcedNodes.delete(found.nodeId);
		return ok({ found: true });
	}

	/** Close the forced-state session: clear every node we forced and drop emulated media. */
	private async forceEnd(): Promise<Envelope<{ detached: boolean }>> {
		if (!this.cdp) return ok({ detached: false });
		const cdp = this.cdp;
		for (const nodeId of this.forcedNodes) {
			try {
				await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
			} catch {
				// The node may be gone; nothing left to clear on it.
			}
		}
		this.forcedNodes.clear();
		this.forceRootNodeId = null;
		try {
			await cdp.send('Emulation.setEmulatedMedia', { features: [] });
		} catch {
			// Best-effort media reset.
		}
		return ok({ detached: true });
	}

	/** Release the CDP session. Call once the page's work is done. */
	async dispose(): Promise<void> {
		if (this.cdp) {
			await this.cdp.detach().catch(() => {});
			this.cdp = null;
		}
	}
}

// --- CDP result shapes and transforms (mirrors the extension background worker) ---

interface DomNode {
	nodeId: number;
	shadowRootType?: string;
	children?: DomNode[];
	shadowRoots?: DomNode[];
	contentDocument?: DomNode;
}

interface CdpRule {
	selector: string;
	properties: Record<string, string>;
	media?: string;
}

interface RuleMatch {
	rule?: {
		origin?: string;
		selectorList?: { text?: string };
		style?: { cssProperties?: Array<{ name?: string; value?: string; implicit?: boolean; disabled?: boolean; parsedOk?: boolean }> };
		media?: Array<{ text?: string }>;
	};
}

interface MatchedStyles {
	inherited?: Array<{ matchedCSSRules?: RuleMatch[] }>;
}

/** Recursively count closed shadow roots in a pierced DOM tree, for transparency. */
function countClosedShadowRoots(node: DomNode): number {
	let count = node.shadowRootType === 'closed' ? 1 : 0;
	for (const child of node.children ?? []) count += countClosedShadowRoots(child);
	for (const root of node.shadowRoots ?? []) count += countClosedShadowRoots(root);
	if (node.contentDocument) count += countClosedShadowRoots(node.contentDocument);
	return count;
}

/** Lift one authored, non-user-agent rule from a RuleMatch, dropping inert declarations. */
function stripCdpRule(rm: RuleMatch): CdpRule | null {
	const rule = rm.rule;
	if (!rule) return null;
	if ((rule.origin ?? 'regular') === 'user-agent') return null;
	const selector = rule.selectorList?.text;
	if (!selector) return null;
	const properties: Record<string, string> = {};
	for (const p of rule.style?.cssProperties ?? []) {
		if (p.implicit || p.disabled || p.parsedOk === false) continue;
		if (!p.name || p.value == null) continue;
		properties[p.name] = p.value;
	}
	if (Object.keys(properties).length === 0) return null;
	const media = rule.media?.find((m) => m.text)?.text;
	return media ? { selector, properties, media } : { selector, properties };
}

/** Map a small set of asset extensions to a mime, when the response omits content-type. */
function mimeFromUrl(pathname: string): string | null {
	const ext = pathname.split('.').pop()?.toLowerCase();
	const map: Record<string, string> = {
		woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
		png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
	};
	return ext ? map[ext] ?? null : null;
}
