/**
 * test/run.ts: end-to-end tests for the snipcode cli.
 *
 * Serves the fixtures over http, then drives the *built* cli as a subprocess for every
 * scenario and asserts against the JSON it prints and the files it writes. This is the
 * real integration surface an agent shells out to, so the tests exercise it exactly as
 * an agent would: argv in, one JSON object out, side-effect files under --out.
 *
 * Run with: npm test (builds first). Requires `npx playwright install chromium`.
 */
import { createServer, type Server } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname, extname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const CLI = join(ROOT, 'dist', 'cli', 'index.js');
const FIXTURES = join(HERE, 'fixtures');
const OUT_BASE = join(HERE, '.out');

const MIME: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };

/** One CLI invocation's result: exit code plus the parsed JSON it printed. */
interface CliResult {
	code: number;
	// Parsed CLI output is arbitrary JSON; `any` keeps the assertions readable.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	json: any;
	raw: string;
}

/** Run the built cli with args, returning its exit code and parsed stdout JSON. */
function runCli(args: string[]): Promise<CliResult> {
	return new Promise((resolve) => {
		execFile(process.execPath, [CLI, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
			const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 0;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let json: any = {};
			try {
				json = JSON.parse(stdout);
			} catch {
				// Left empty; assertions on json will fail and surface the raw output.
			}
			resolve({ code, json, raw: stdout });
		});
	});
}

// --- tiny assertion harness ---
let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
	if (cond) {
		passed++;
		process.stdout.write(`  ok  ${name}\n`);
	} else {
		failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
		process.stdout.write(`FAIL  ${name}${detail ? ` — ${detail}` : ''}\n`);
	}
}

/** Start a static file server for the fixtures dir on an ephemeral port. */
function startServer(): Promise<{ server: Server; base: string }> {
	return new Promise((resolve) => {
		const server = createServer(async (req, res) => {
			const path = join(FIXTURES, decodeURIComponent((req.url ?? '/').split('?')[0]!));
			try {
				const body = await readFile(path);
				res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
				res.end(body);
			} catch {
				res.writeHead(404);
				res.end('not found');
			}
		});
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			resolve({ server, base: `http://127.0.0.1:${port}` });
		});
	});
}

async function main(): Promise<void> {
	if (!existsSync(CLI)) {
		process.stdout.write(`cli not built at ${CLI}; run \`npm run build\` first\n`);
		process.exitCode = 1;
		return;
	}
	await rm(OUT_BASE, { recursive: true, force: true });
	const { server, base } = await startServer();
	const sample = `${base}/sample.html`;
	const builder = `${base}/builder.html`;

	try {
		// --- candidates ---
		process.stdout.write('\ncandidates:\n');
		const cand = await runCli(['candidates', sample, '--out', join(OUT_BASE, 'cand')]);
		const candidates = (cand.json.candidates as any[]) ?? [];
		const login = candidates.find((c) => c.role === 'button' && String(c.text ?? '').trim() === 'Log In');
		const landmarks = (cand.json.landmarks as any[]) ?? [];
		check('candidates exits 0', cand.code === 0, `code ${cand.code}`);
		check('candidates returns a non-empty inventory', candidates.length > 0, `${candidates.length} found`);
		check('candidates finds the login button', !!login && login.role === 'button', JSON.stringify(login));
		check('login candidate has a durable selector', !!login && typeof login.selector === 'string' && (login.selector as string).length > 0);
		check('candidates reports landmarks', landmarks.some((l) => l.role === 'banner') && landmarks.some((l) => l.role === 'nav'));
		check('cards are collapsed to one repeat representative', candidates.some((c) => typeof c.repeat === 'number' && (c.repeat as number) >= 3));
		check('candidates screenshot written', typeof cand.json.screenshot === 'string' && existsSync(cand.json.screenshot as string));
		check('candidates carries inline guidance', typeof cand.json.guidance === 'string');

		// --- extract (html, the happy path) ---
		process.stdout.write('\nextract (html):\n');
		const ex = await runCli(['extract', sample, '--selector', '#login', '--out', join(OUT_BASE, 'ex')]);
		const artifact = ex.json.artifact as string | undefined;
		const doc = artifact && existsSync(artifact) ? readFileSync(artifact, 'utf8') : '';
		check('extract exits 0', ex.code === 0, `code ${ex.code}`);
		check('extract did not hit the builder gate', ex.json.builderDetected === false);
		check('extract wrote output.html', !!artifact && existsSync(artifact));
		check('artifact contains the button label', doc.includes('Log In'));
		check('artifact carries the brand color', /#2b6cb0|rgb\(43, ?108, ?176\)/i.test(doc), 'brand color baked');
		check('artifact is self-contained (no http asset refs)', !/https?:\/\//.test(doc.replace(/https?:\/\/(www\.)?w3\.org/g, '')), 'no external urls');

		// --- extract with drift verification ---
		process.stdout.write('\nextract (drift verification):\n');
		const good = await runCli(['extract', sample, '--selector', '#login', '--expect-text', 'Log In', '--out', join(OUT_BASE, 'good')]);
		check('extract with correct --expect-text passes', good.code === 0 && good.json.builderDetected === false);
		const shifted = await runCli(['extract', sample, '--selector', '#login', '--expect-text', 'Totally Different Zzz', '--out', join(OUT_BASE, 'shift')]);
		check('extract with wrong --expect-text fails PAGE_SHIFTED', shifted.code === 1 && (shifted.json.error?.code) === 'PAGE_SHIFTED', shifted.raw.slice(0, 120));

		// --- extract error contract ---
		process.stdout.write('\nextract (errors):\n');
		const noMatch = await runCli(['extract', sample, '--selector', '#nope', '--out', join(OUT_BASE, 'nomatch')]);
		check('unknown selector fails SELECTOR_NO_MATCH', noMatch.code === 1 && (noMatch.json.error?.code) === 'SELECTOR_NO_MATCH');
		const badFmt = await runCli(['extract', sample, '--selector', '#login', '--format', 'crayon', '--out', join(OUT_BASE, 'badfmt')]);
		check('unknown format fails BAD_FORMAT', badFmt.code === 1 && (badFmt.json.error?.code) === 'BAD_FORMAT');

		// --- extract other formats ---
		process.stdout.write('\nextract (formats):\n');
		for (const fmt of ['tailwind', 'jsx', 'vue']) {
			const r = await runCli(['extract', sample, '--selector', '#login', '--format', fmt, '--out', join(OUT_BASE, `fmt-${fmt}`)]);
			check(`extract --format ${fmt} succeeds`, r.code === 0 && r.json.builderDetected === false, r.raw.slice(0, 120));
		}

		// --- builder gate ---
		process.stdout.write('\nbuilder gate:\n');
		const built = await runCli(['extract', builder, '--selector', '#hero', '--out', join(OUT_BASE, 'builder')]);
		check('builder page is detected, not snipped', built.code === 0 && built.json.builderDetected === true, built.raw.slice(0, 160));
		check('builder is named framer', built.json.builder === 'framer', String(built.json.builder));
		check('builder crop screenshot written', typeof built.json.elementScreenshot === 'string' && existsSync(built.json.elementScreenshot as string));

		// --- schema ---
		process.stdout.write('\nschema:\n');
		const sc = await runCli(['schema', sample, '--out', join(OUT_BASE, 'schema')]);
		const tokens = sc.json.tokens as { colors?: unknown[]; fonts?: unknown[] } | undefined;
		const voice = (sc.json.voice as any[]) ?? [];
		check('schema exits 0', sc.code === 0, sc.raw.slice(0, 160));
		check('schema.json written', typeof sc.json.schema === 'string' && existsSync(sc.json.schema as string));
		check('schema.md written', typeof sc.json.markdown === 'string' && existsSync(sc.json.markdown as string));
		check('schema screenshot written', typeof sc.json.screenshot === 'string' && existsSync(sc.json.screenshot as string));
		check('schema has color tokens', !!tokens?.colors && tokens.colors.length > 0);
		check('schema has a section blueprint', Array.isArray(sc.json.sections) && (sc.json.sections as unknown[]).length > 0);
		check('schema sampled voice components', voice.length > 0, `${voice.length} samples`);
		const md = typeof sc.json.markdown === 'string' ? readFileSync(sc.json.markdown, 'utf8') : '';
		check('schema.md renders tokens + layout', md.includes('## Tokens') && md.includes('## Layout'));
	} finally {
		server.close();
	}

	process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
	if (failures.length) {
		process.stdout.write(`\nfailures:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
		process.exitCode = 1;
	}
}

main().catch((err) => {
	process.stdout.write(`test harness crashed: ${(err as Error).message}\n`);
	process.exitCode = 1;
});
