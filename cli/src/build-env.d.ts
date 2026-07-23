/**
 * cli/src/build-env.d.ts: the values the bundler substitutes at build time.
 *
 * These are not real runtime bindings. Vite's `define` replaces each one with a literal
 * while bundling dist/cli/index.js, so the shipped code carries the value inline. They are
 * declared here only so the typechecker, which never runs the bundler, knows their types.
 */

/** The package version, read from package.json by vite.node.config.ts at build time. */
declare const __SNIPCODE_VERSION__: string;
