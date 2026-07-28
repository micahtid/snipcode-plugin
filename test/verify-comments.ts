/**
 * test/verify-comments.ts: proves a comment pass touched no code.
 *
 * Both bundles are minified, so comments never reach them. A rewrite that only edits comments
 * therefore produces byte-identical output, and any hash change means an edit slipped into
 * code. Record the hashes before the pass, run the check after.
 *
 * Run with: npm run verify:comments -- --record, then npm run verify:comments.
 *
 * One thing is deliberately not covered: instructions/guidance.ts holds agent-facing strings,
 * not comments. Editing those does change the bundle, and does need npm run gen:skill. The
 * suite already fails when the committed skill files drift.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, ROOT } from './harness';

const BASELINE = join(HERE, '.build-hash.json');
const BUNDLES = ['dist/core/core.iife.js', 'dist/cli/index.js'];

/** The sha256 of each built bundle, keyed by its path. */
function hashes(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rel of BUNDLES) {
		const path = join(ROOT, rel);
		if (!existsSync(path)) {
			process.stdout.write(`${rel} is not built; run \`npm run build\` first\n`);
			process.exit(1);
		}
		out[rel] = createHash('sha256').update(readFileSync(path)).digest('hex');
	}
	return out;
}

function main(): void {
	const current = hashes();
	if (process.argv.includes('--record')) {
		writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
		process.stdout.write('recorded build hashes:\n');
		for (const [rel, hash] of Object.entries(current)) process.stdout.write(`  ${hash.slice(0, 16)}  ${rel}\n`);
		return;
	}

	if (!existsSync(BASELINE)) {
		process.stdout.write('no recorded build hashes; run `npm run verify:comments -- --record` before the pass\n');
		process.exitCode = 1;
		return;
	}

	const recorded = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, string>;
	let failed = false;
	process.stdout.write('\nbuild hashes:\n');
	for (const [rel, hash] of Object.entries(current)) {
		const was = recorded[rel];
		const same = was === hash;
		if (!same) failed = true;
		process.stdout.write(`  ${same ? 'ok  ' : 'MOVED'} ${rel}: ${hash.slice(0, 16)}${same ? '' : ` (was ${String(was).slice(0, 16)})`}\n`);
	}
	if (failed) {
		process.stdout.write('\nA bundle moved, so the pass changed code, not only comments.\n');
		process.exitCode = 1;
	}
}

main();
