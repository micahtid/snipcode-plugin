/**
 * vite.node.config.ts: bundle the Node cli + runner to dist/cli/index.js.
 *
 * The cli, runner, instructions, and core's type-only imports bundle into one ESM
 * file with a node shebang; Playwright and node builtins stay external (Playwright
 * ships native browser binaries and must resolve from node_modules at runtime). The
 * core iife is NOT bundled here: the runner reads it off disk and injects it into a
 * page, so it lives at dist/core/core.iife.js from the separate core build.
 */
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import { readFileSync } from 'node:fs';

// The version is read here and inlined into the bundle, so the cli reports exactly the
// version npm installed rather than a hand-edited copy that can drift.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

const external = [
	'playwright',
	'playwright-core',
	...builtinModules,
	...builtinModules.map((m) => `node:${m}`),
];

export default defineConfig({
	publicDir: false,
	define: {
		__SNIPCODE_VERSION__: JSON.stringify(pkg.version),
	},
	build: {
		outDir: fileURLToPath(new URL('./dist/cli', import.meta.url)),
		emptyOutDir: true,
		ssr: true,
		target: 'node18',
		// No sourcemap: it was 44 percent of the published payload for a cli nobody debugs from
		// an install. A stack trace against the repo build still maps.
		sourcemap: false,
		lib: {
			entry: fileURLToPath(new URL('./cli/src/index.ts', import.meta.url)),
			formats: ['es'],
			fileName: () => 'index.js',
		},
		rollupOptions: {
			external,
			output: {
				// Preserve the executable shebang so `npx snipcode` / the bin runs directly.
				banner: '#!/usr/bin/env node',
			},
		},
	},
});
