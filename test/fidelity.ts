/**
 * test/fidelity.ts: render-fidelity bench for the extract pipeline.
 *
 * The e2e suite proves the cli contract; this proves the port is visually faithful.
 * It screenshots the live element, runs extract, screenshots the rendered artifact,
 * and pixel-compares the two. A high mismatch means the port lost styling the
 * extension would have kept. Reuses the fidelity-harness pattern (screenshot in,
 * screenshot out, pixel diff) rather than the extension's full bundle corpus.
 *
 * Run with: npm run test:fidelity (build first). Kept out of `npm test` so a pixel
 * threshold never gates the deterministic contract tests.
 */
import { createServer, type Server } from 'node:http';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { chromium } from 'playwright';
import { mismatchRatio } from './pixels';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname, extname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const CLI = join(ROOT, 'dist', 'cli', 'index.js');
const FIXTURES = join(HERE, 'fixtures');
const OUT = join(HERE, '.fidelity');
/** Max share of mismatched pixels tolerated for a snip to count as faithful. */
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

async function main(): Promise<void> {
	if (!existsSync(CLI)) {
		process.stdout.write(`cli not built; run \`npm run build\` first\n`);
		process.exitCode = 1;
		return;
	}
	await rm(OUT, { recursive: true, force: true });
	await mkdir(OUT, { recursive: true });
	const { server, base } = await startServer();
	const browser = await chromium.launch();
	let failed = false;
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
		await page.goto(`${base}/sample.html`, { waitUntil: 'networkidle' });

		// Reference: the live element.
		const original = await page.locator('#login').screenshot({ type: 'png' });

		// Candidate: the extracted artifact, rendered standalone.
		await runCli(['extract', `${base}/sample.html`, '--selector', '#login', '--out', OUT]);
		const artifact = join(OUT, 'output.html');
		if (!existsSync(artifact)) throw new Error('extract produced no output.html');
		const rendered = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
		await rendered.goto(pathToFileURL(artifact).href, { waitUntil: 'networkidle' });
		const button = rendered.locator('button').first();
		const shot = await button.screenshot({ type: 'png' });

		// Keep the shots for inspection either way.
		writeFileSync(join(OUT, 'original.png'), original);
		writeFileSync(join(OUT, 'rendered.png'), shot);
		const ratio = mismatchRatio(original, shot);
		const pct = (ratio * 100).toFixed(2);
		const pass = ratio <= THRESHOLD;
		failed = !pass;
		process.stdout.write(`login button fidelity: ${pct}% mismatch (threshold ${(THRESHOLD * 100).toFixed(0)}%) — ${pass ? 'PASS' : 'FAIL'}\n`);
	} catch (err) {
		failed = true;
		process.stdout.write(`fidelity bench crashed: ${(err as Error).message}\n`);
	} finally {
		await browser.close();
		server.close();
	}
	if (failed) process.exitCode = 1;
}

main().catch((err) => {
	process.stdout.write(`fidelity harness crashed: ${(err as Error).message}\n`);
	process.exitCode = 1;
});
