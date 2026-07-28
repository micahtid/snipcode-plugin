/**
 * runner/src/browser.ts: launch, navigate, wait, inject, and drive.
 *
 * Loads the url with the deterministic defaults every run shares, a 1440x900 desktop
 * viewport, load plus network idle plus fonts ready, and one lazy-content scroll pass;
 * installs the Host binding; injects the core iife; then drives the three commands over
 * page.evaluate. Nothing here knows the pipeline internals. It only knows how to load a page
 * and hand core its privileged services.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { PlaywrightHost } from './host';
import { fullPage, elementCrop } from './screenshot';

/** Page-loading defaults, fixed so two runs of one page are comparable. */
const VIEWPORT = { width: 1440, height: 900 };
const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const NAV_TIMEOUT_MS = 45_000;
const NETWORK_IDLE_MS = 15_000;
const SETTLE_MS = 500;

/** Signals that the page is a bot wall or consent gate rather than the real content. */
const BLOCK_SIGNALS = [
	/just a moment/i,
	/checking your browser/i,
	/verify you are human/i,
	/enable javascript and cookies/i,
	/access denied/i,
	/attention required/i,
];

/** Raised when the page is a bot wall / consent gate; carries a screenshot for the agent. */
export class PageBlockedError extends Error {
	constructor(
		message: string,
		readonly screenshot: Buffer,
	) {
		super(message);
		this.name = 'PageBlockedError';
	}
}

/** Locate the built core iife on disk, from either the built package or a dev checkout. */
function coreBundlePath(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	// Walk up looking for dist/core/core.iife.js, so this resolves whether the runner
	// runs from dist/ (built) or from runner/src/ under tsx (dev).
	for (let i = 0; i < 6; i++) {
		const candidate = join(dir, 'dist', 'core', 'core.iife.js');
		if (existsSync(candidate)) return candidate;
		const sibling = join(dir, 'core', 'core.iife.js');
		if (existsSync(sibling)) return sibling;
		dir = dirname(dir);
	}
	throw new Error('core bundle not found: run `npm run build:core` first');
}

/** Options controlling how the runner loads a page. */
export interface LoadOptions {
	headless?: boolean;
	viewport?: { width: number; height: number };
}

/** A loaded, core-injected page ready to answer the three commands. */
export interface Driver {
	page: Page;
	candidates(): Promise<unknown>;
	extract(selector: string, format: string, expect?: unknown): Promise<ExtractOutcome>;
	schema(): Promise<unknown>;
	fullScreenshot(): Promise<Buffer>;
	elementScreenshot(selector: string): Promise<Buffer | null>;
}

/** The shape extract returns from the page, enough for the cli to branch on. */
export interface ExtractOutcome {
	ok: boolean;
	error?: { code: string; message: string; actual?: unknown };
	selector: string;
	rect?: { x: number; y: number; w: number; h: number };
	builderDetected?: boolean;
	builder?: string | null;
	html?: string;
	css?: string;
	output?: string;
	files?: unknown;
	warnings?: string[];
}

/**
 * Loads a url, injects core, runs fn against the driver, and always tears the browser
 * down. Throws PageBlockedError when the loaded page looks like a bot wall or consent
 * gate, so the cli can report it honestly with a screenshot rather than snip garbage.
 */
export async function withPage<T>(url: string, opts: LoadOptions, fn: (driver: Driver) => Promise<T>): Promise<T> {
	const browser: Browser = await chromium.launch({ headless: opts.headless !== false });
	try {
		const context = await browser.newContext({
			viewport: opts.viewport ?? VIEWPORT,
			deviceScaleFactor: 1,
			userAgent: USER_AGENT,
		});
		const page = await context.newPage();
		page.setDefaultTimeout(NAV_TIMEOUT_MS);

		const host = new PlaywrightHost(page);
		await host.install();

		await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
		await settlePage(page);
		await detectBlock(page);

		// Inject the core iife into the main world; it hangs window.__snipCore.
		await page.addScriptTag({ content: readFileSync(coreBundlePath(), 'utf8') });
		await page.waitForFunction(() => typeof (window as unknown as { __snipCore?: unknown }).__snipCore !== 'undefined', null, {
			timeout: 5000,
		});

		const driver: Driver = {
			page,
			candidates: () => page.evaluate(() => (window as unknown as { __snipCore: { candidates(): unknown } }).__snipCore.candidates()),
			extract: (selector, format, expect) =>
				page.evaluate(
					([sel, fmt, exp]) =>
						(window as unknown as { __snipCore: { extract(s: string, f: string, e?: unknown): Promise<ExtractOutcome> } }).__snipCore.extract(
							sel as string,
							fmt as string,
							exp,
						),
					[selector, format, expect] as const,
				),
			schema: () =>
				page.evaluate(() => (window as unknown as { __snipCore: { schema(): unknown } }).__snipCore.schema()),
			fullScreenshot: () => fullPage(page),
			elementScreenshot: (selector) => elementCrop(page, selector),
		};

		return await fn(driver);
	} finally {
		await browser.close();
	}
}

/** Load, network-idle, fonts-ready, then one scroll-to-bottom pass to trigger lazy content. */
async function settlePage(page: Page): Promise<void> {
	await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_MS }).catch(() => {});
	await page.evaluate(() => document.fonts?.ready).catch(() => {});
	// Drive lazy content: scroll to the bottom in steps, then back to the top.
	await page
		.evaluate(async () => {
			const step = window.innerHeight;
			for (let y = 0; y <= document.body.scrollHeight; y += step) {
				window.scrollTo(0, y);
				await new Promise((r) => setTimeout(r, 60));
			}
			window.scrollTo(0, 0);
		})
		.catch(() => {});
	await page.waitForTimeout(SETTLE_MS);
}

/** Throw PageBlockedError when the page reads as a bot wall or consent gate. */
async function detectBlock(page: Page): Promise<void> {
	const text = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? '').catch(() => '');
	const hit = BLOCK_SIGNALS.find((re) => re.test(text));
	if (!hit) return;
	const shot = await fullPage(page).catch(() => Buffer.alloc(0));
	throw new PageBlockedError(`page looks blocked (matched ${hit}); likely a bot wall or consent gate`, shot);
}
