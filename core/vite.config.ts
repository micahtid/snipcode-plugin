/**
 * core/vite.config.ts: bundle the in-page core to one injectable iife.
 *
 * The runner injects this single file into a Playwright page's main world, so the
 * output must be self-contained: no code splitting, no dynamic import, a stable
 * filename the runner reads off disk. Mirrors the extension's content-script build,
 * which has the same one-file-in-a-page constraint.
 */
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	publicDir: false,
	build: {
		outDir: fileURLToPath(new URL('../dist/core', import.meta.url)),
		emptyOutDir: true,
		sourcemap: false,
		lib: {
			entry: fileURLToPath(new URL('./src/entry.ts', import.meta.url)),
			formats: ['iife'],
			name: 'SnipCore',
			fileName: () => 'core.iife.js',
		},
		rollupOptions: {
			output: {
				entryFileNames: 'core.iife.js',
				inlineDynamicImports: true,
			},
		},
	},
});
