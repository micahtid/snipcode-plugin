/**
 * test/harness.ts: the pieces every test script needs.
 *
 * Serves the fixtures over http, runs the built cli as a subprocess, and counts
 * assertions. The four test scripts import from here so there is one server and one
 * cli driver, not four copies.
 */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname, extname } from 'node:path';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
export const CLI = join(ROOT, 'dist', 'cli', 'index.js');
export const FIXTURES = join(HERE, 'fixtures');

const MIME: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };

/** One cli invocation's result: exit code, parsed stdout JSON, and the raw stdout. */
export interface CliResult {
	code: number;
	// Parsed cli output is arbitrary JSON; `any` keeps the assertions readable.
	json: any;
	raw: string;
}

/** Run the built cli with args, returning its exit code and parsed stdout JSON. */
export function runCli(args: string[]): Promise<CliResult> {
	return new Promise((resolve) => {
		execFile(process.execPath, [CLI, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
			const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 0;
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

/** Start a static file server for the fixtures dir on an ephemeral port. */
export function startServer(): Promise<{ server: Server; base: string }> {
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

/**
 * A stylesheet served from a second origin, without cors headers, so the page context cannot
 * read its rules. This is the shape of a cdn-hosted sheet: the breakpoint it declares reaches
 * the schema only if the extractor recovers the text through the Host.
 */
const CROSS_ORIGIN_CSS = `@media (min-width: 1280px) { ._m6p7 { padding: 120px 32px; } }`;

/** Start the second-origin server, on its own port, serving only that stylesheet. */
export function startCrossOriginServer(): Promise<{ server: Server; url: string }> {
	return new Promise((resolve) => {
		const server = createServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/css' });
			res.end(CROSS_ORIGIN_CSS);
		});
		// A different port is a different origin, so the page cannot read this sheet's rules.
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			resolve({ server, url: `http://127.0.0.1:${port}/cdn.css` });
		});
	});
}

/** A running tally of assertions, so a script can report one pass/fail line at the end. */
export class Checks {
	passed = 0;
	readonly failures: string[] = [];

	/** Record one assertion, printing it as it runs. */
	check(name: string, cond: boolean, detail = ''): void {
		if (cond) {
			this.passed++;
			process.stdout.write(`  ok  ${name}\n`);
		} else {
			this.failures.push(`${name}${detail ? `: ${detail}` : ''}`);
			process.stdout.write(`FAIL  ${name}${detail ? `: ${detail}` : ''}\n`);
		}
	}

	/** Print the totals and the failure list. Returns true when everything passed. */
	report(): boolean {
		process.stdout.write(`\n${this.passed} passed, ${this.failures.length} failed\n`);
		if (this.failures.length) {
			process.stdout.write(`\nfailures:\n${this.failures.map((f) => `  - ${f}`).join('\n')}\n`);
		}
		return this.failures.length === 0;
	}
}
