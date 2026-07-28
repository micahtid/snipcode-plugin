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
