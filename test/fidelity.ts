/**
 * test/fidelity.ts: render-fidelity bench for the extract pipeline.
 *
 * The e2e suite proves the cli contract and the goldens pin its bytes; this proves the
 * artifact still looks like the element it came from. For each target it screenshots the
 * live element, runs extract, screenshots the rendered artifact, and pixel-compares the
 * two. A high mismatch means the snip lost styling nothing else would notice.
 *
 * Exits 2, not 1, so a pixel wobble reads differently from a contract break.
 */
import { rm, mkdir } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { mismatchRatio } from './pixels';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { CLI, HERE, runCli, startServer } from './harness';

const OUT = join(HERE, '.fidelity');
/** Max share of mismatched pixels tolerated for a snip to count as faithful. */
const THRESHOLD = 0.03;
/** Exit code for a pixel miss, distinct from 1 so a contract break stays distinguishable. */
const PIXEL_MISS = 2;

/** One comparison: an element on a fixture page, and the tag it renders back as. */
interface Target {
	name: string;
	page: string;
	selector: string;
	/** The selector to screenshot inside the artifact, which has no ids of its own to rely on. */
	rendered: string;
}

const TARGETS: Target[] = [
	{ name: 'login button', page: 'sample.html', selector: '#login', rendered: 'button' },
	{ name: 'feature card', page: 'framework.html', selector: 'article', rendered: 'body > *' },
	{ name: 'nav bar', page: 'framework.html', selector: 'header', rendered: 'body > *' },
];

async function main(): Promise<void> {
	if (!existsSync(CLI)) {
		process.stdout.write('cli not built; run `npm run build` first\n');
		process.exitCode = 1;
		return;
	}
	await rm(OUT, { recursive: true, force: true });
	await mkdir(OUT, { recursive: true });
	const { server, base } = await startServer();
	const browser = await chromium.launch();
	let missed = 0;
	let crashed = false;

	process.stdout.write('\nfidelity:\n');
	try {
		for (const target of TARGETS) {
			const dir = join(OUT, target.name.replace(/\s+/g, '-'));
			try {
				const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
				await page.goto(`${base}/${target.page}`, { waitUntil: 'networkidle' });
				const original = await page.locator(target.selector).first().screenshot({ type: 'png' });
				await page.close();

				await runCli(['extract', `${base}/${target.page}`, '--selector', target.selector, '--out', dir]);
				const artifact = join(dir, 'output.html');
				if (!existsSync(artifact)) throw new Error('extract produced no output.html');
				const rendered = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
				await rendered.goto(pathToFileURL(artifact).href, { waitUntil: 'networkidle' });
				const shot = await rendered.locator(target.rendered).first().screenshot({ type: 'png' });
				await rendered.close();

				// Keep the shots for inspection either way; a pixel failure is unreadable without them.
				await mkdir(dir, { recursive: true });
				writeFileSync(join(dir, 'original.png'), original);
				writeFileSync(join(dir, 'rendered.png'), shot);
				const ratio = mismatchRatio(original, shot);
				const pass = ratio <= THRESHOLD;
				if (!pass) missed++;
				process.stdout.write(`  ${pass ? 'ok  ' : 'MISS'} ${target.name}: ${(ratio * 100).toFixed(2)}% mismatch (threshold ${(THRESHOLD * 100).toFixed(0)}%)\n`);
			} catch (err) {
				crashed = true;
				process.stdout.write(`  FAIL ${target.name}: ${(err as Error).message}\n`);
			}
		}
	} finally {
		await browser.close();
		server.close();
	}

	process.stdout.write(`\n${TARGETS.length - missed} of ${TARGETS.length} targets within threshold\n`);
	if (crashed) process.exitCode = 1;
	else if (missed) process.exitCode = PIXEL_MISS;
}

main().catch((err) => {
	process.stdout.write(`fidelity harness crashed: ${(err as Error).message}\n`);
	process.exitCode = 1;
});
