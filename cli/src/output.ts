/**
 * cli/src/output.ts: the machine-facing output contract.
 *
 * Every command prints exactly one JSON object to stdout. Success is the command's
 * payload; failure is { error: { code, message } } with a nonzero exit code, so an
 * agent never has to parse prose. File side effects (screenshots, the artifact, the
 * schema) are written under --out and referenced by path in the JSON.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { OutputFormat } from '../../core/src/types';

/**
 * The four agent-facing format names and the pipeline format each one selects. The names
 * differ because `jsx` reads better than `jsx-tailwind` on a command line, and because
 * `html` and `bem-css` are the same emitter under two names.
 */
const FORMAT_ALIASES: Record<string, OutputFormat> = {
	html: 'html',
	jsx: 'jsx-tailwind',
	tailwind: 'tailwind',
	vue: 'vue',
};

/** Agent-facing format names shown in help. */
export const FORMAT_NAMES = ['html', 'jsx', 'tailwind', 'vue'];

/** Normalize a --format value to a pipeline OutputFormat, or throw with the valid set. */
export function normalizeFormat(input: string | undefined): OutputFormat {
	if (!input) return 'html';
	const format = FORMAT_ALIASES[input.toLowerCase()];
	if (!format) throw new Error(`unknown --format "${input}"; expected one of: ${FORMAT_NAMES.join(', ')}`);
	return format;
}

/** The only schemes the runner will load. snipcode reads web pages, never the local disk. */
const URL_SCHEMES = ['http:', 'https:'];

/** A leading `word:`, and the `host:port` form that looks like one but is not. */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const HOST_PORT = /^[^/?#:]+:\d+(?:$|[/?#])/;

/**
 * Normalize a <url> argument to an absolute http or https url, or throw with the reason.
 *
 * Two jobs. A bare host gains https://, so `snipcode schema example.com` loads the page rather
 * than dying inside Playwright with a stack trace that reads like a crash. Every other scheme
 * is refused: file: and data: would turn a page reader into a way to read the caller's disk.
 */
export function normalizeUrl(input: string): string {
	const raw = input.trim();
	if (!raw) throw new Error('<url> is empty');
	// `localhost:3000` matches the scheme shape, so the port form is checked first.
	const bare = !SCHEME.test(raw) || HOST_PORT.test(raw);
	let parsed: URL;
	try {
		parsed = new URL(bare ? `https://${raw}` : raw);
	} catch {
		throw new Error(`<url> is not a url: ${input}`);
	}
	if (!URL_SCHEMES.includes(parsed.protocol)) {
		throw new Error(`<url> must be http or https, not "${parsed.protocol.slice(0, -1)}": ${input}`);
	}
	return parsed.href;
}

/** Print one success payload as JSON and exit 0. */
export function emit(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/** Print a JSON error envelope and set a nonzero exit code. */
export function emitError(code: string, message: string, extra?: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify({ error: { code, message, ...extra } }, null, 2)}\n`);
	process.exitCode = 1;
}

/** Create the output directory (default ./snipcode-out) and return its absolute path. */
export function ensureOutDir(dir: string | undefined): string {
	const out = resolve(dir ?? 'snipcode-out');
	mkdirSync(out, { recursive: true });
	return out;
}

/** Write a file under the out dir and return its absolute path. */
export function writeOut(outDir: string, name: string, data: string | Buffer): string {
	const path = join(outDir, name);
	writeFileSync(path, data);
	return path;
}

/** Decode a base64 data uri to a Buffer, or null when the string is not one. */
export function dataUrlToBuffer(dataUrl: string): Buffer | null {
	const match = /^data:[^;]+;base64,(.*)$/s.exec(dataUrl);
	return match?.[1] ? Buffer.from(match[1], 'base64') : null;
}
