/**
 * test/parity.ts: extension-vs-cli parity bench (plan build phase 1 parity check).
 *
 * Confirms the port did not change behavior: it snips the same element two ways, the
 * built SnipCode extension (chrome.debugger + background fetch) and this plugin's cli
 * (Playwright CDPSession + node fetch), then renders both artifacts and pixel-compares
 * them. A low mismatch means the Host reimplementation reproduces the extension's
 * result. Render parity, not byte parity: generated class names differ harmlessly
 * between runs, but the rendered pixels must match.
 *
 * Dev-only and optional: it reaches into the sibling chrome-extension test harness, so
 * it is not part of `npm test`. If the extension is not built, it skips cleanly.
 * Run with: npm run test:parity (build the plugin and the extension first).
 */
import { createServer, type Server } from 'node:http';
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { chromium, type Browser } from 'playwright';
import { mismatchRatio } from './pixels';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname, extname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const CLI = join(ROOT, 'dist', 'cli', 'index.js');
const FIXTURES = join(HERE, 'fixtures');
const OUT = join(HERE, '.parity');
const EXT_HARNESS = join(ROOT, '..', 'chrome-extension', 'tests', 'run-pipeline.mjs');
const EXT_DIST = join(ROOT, '..', 'chrome-extension', 'dist', 'manifest.json');
/** Max share of mismatched pixels tolerated between the two artifacts. */
const THRESHOLD = 0.03;

const MIME: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' };

function startServer(): Promise<{ server: Server; base: string }> {
	return new Promise((resolve) => {
		const server = createServer(async (req, res) => {
			try {
				const body = await readFile(join(FIXTURES, decodeURIComponent((req.url ?? '/').split('?')[0]!)));
				res.writeHead(200, { 'content-type': MIME[extname(req.url ?? '')] ?? 'application/octet-stream' });
				res.end(body);
			} catch {
				res.writeHead(404);
				res.end();
			}
		});
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			resolve({ server, base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` });
		});
	});
}

function runCli(args: string[]): Promise<string> {
	return new Promise((resolve) => {
		execFile(process.execPath, [CLI, ...args], { maxBuffer: 64 * 1024 * 1024 }, (_e, stdout) => resolve(stdout));
	});
}

/** Screenshot the first button of an html file rendered standalone. */
async function shotButton(browser: Browser, htmlPath: string): Promise<Buffer> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
	await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });
	const shot = await page.locator('button').first().screenshot({ type: 'png' });
	await page.close();
	return shot;
}

async function main(): Promise<void> {
	if (!existsSync(CLI)) {
		process.stdout.write('cli not built; run `npm run build` first\n');
		process.exitCode = 1;
		return;
	}
	if (!existsSync(EXT_DIST)) {
		process.stdout.write(`skip: extension not built at ${EXT_DIST} (run its \`npm run build\`)\n`);
		return; // Optional bench: a missing extension is a skip, not a failure.
	}
	// Import the sibling extension harness lazily so a missing sibling does not break typecheck runs.
	const ext = (await import(pathToFileURL(EXT_HARNESS).href)) as {
		launchExtensionContext(dpr?: number): Promise<{ context: { close(): Promise<void>; newPage(): unknown }; userDataDir: string }>;
		snipOne(context: unknown, bundle: unknown, extra?: unknown): Promise<{ html: string }>;
	};

	await rm(OUT, { recursive: true, force: true });
	await mkdir(OUT, { recursive: true });
	const { server, base } = await startServer();
	const url = `${base}/sample.html`;
	const selector = '#login';
	let failed = false;

	try {
		// Extension path: snip through the built extension's headless bridge.
		const { context, userDataDir } = await ext.launchExtensionContext(1);
		let extHtml = '';
		try {
			const result = await ext.snipOne(context, { source: { url, selector, viewport: { width: 1440, height: 900 } } });
			extHtml = result.html;
		} finally {
			await context.close();
			await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
		}
		const extPath = join(OUT, 'extension.html');
		await writeFile(extPath, extHtml, 'utf8');

		// Plugin path: snip through the cli.
		await runCli(['extract', url, '--selector', selector, '--out', OUT]);
		const pluginPath = join(OUT, 'output.html');
		if (!existsSync(pluginPath)) throw new Error('cli produced no output.html');

		// Render both and compare.
		const browser = await chromium.launch();
		try {
			const extShot = await shotButton(browser, extPath);
			const pluginShot = await shotButton(browser, pluginPath);
			await writeFile(join(OUT, 'extension.png'), extShot);
			await writeFile(join(OUT, 'plugin.png'), pluginShot);
			const ratio = mismatchRatio(extShot, pluginShot);
			const pass = ratio <= THRESHOLD;
			failed = !pass;
			process.stdout.write(
				`extension-vs-cli parity: ${(ratio * 100).toFixed(2)}% mismatch (threshold ${(THRESHOLD * 100).toFixed(0)}%) — ${pass ? 'PASS' : 'FAIL'}\n`,
			);
		} finally {
			await browser.close();
		}
	} catch (err) {
		failed = true;
		process.stdout.write(`parity bench crashed: ${(err as Error).message}\n`);
	} finally {
		server.close();
	}
	if (failed) process.exitCode = 1;
}

main().catch((err) => {
	process.stdout.write(`parity harness crashed: ${(err as Error).message}\n`);
	process.exitCode = 1;
});
