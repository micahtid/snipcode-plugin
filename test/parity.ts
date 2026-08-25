/**
 * test/parity.ts: extension-vs-cli parity bench.
 *
 * Confirms the port did not change behavior. It snips the same element two ways, through the
 * built SnipCode extension and through this plugin's cli, then renders both artifacts and
 * pixel-compares them. A low mismatch means the Host reimplementation reproduces the
 * extension's result. Render parity, not byte parity: generated class names differ harmlessly
 * between runs, but the rendered pixels must match.
 *
 * Dev-only and optional: it reaches into the sibling chrome-extension test harness, so
 * it is not part of `npm test`. If the extension is not built, it skips cleanly.
 * Run with: npm run test:parity (build the plugin and the extension first).
 */
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { mismatchRatio } from './pixels';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { CLI, HERE, ROOT, runCli, startServer } from './harness';

const OUT = join(HERE, '.parity');
const EXT_HARNESS = join(ROOT, '..', 'chrome-extension', 'tests', 'run-pipeline.mjs');
const EXT_DIST = join(ROOT, '..', 'chrome-extension', 'dist', 'manifest.json');
/** Max share of mismatched pixels tolerated between the two artifacts. */
const THRESHOLD = 0.03;

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
				`extension-vs-cli parity: ${(ratio * 100).toFixed(2)}% mismatch (threshold ${(THRESHOLD * 100).toFixed(0)}%): ${pass ? 'PASS' : 'FAIL'}\n`,
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
