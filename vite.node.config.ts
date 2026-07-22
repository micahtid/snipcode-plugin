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

const external = [
	'playwright',
	'playwright-core',
	...builtinModules,
	...builtinModules.map((m) => `node:${m}`),
];

export default defineConfig({
	publicDir: false,
	build: {
		outDir: fileURLToPath(new URL('./dist/cli', import.meta.url)),
		emptyOutDir: true,
		ssr: true,
		target: 'node18',
		sourcemap: true,
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
