# Changelog

Every schema output is stamped with the version that produced it, so this file is the other
half of that promise: what changed between two stamps.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-25

### Added

- `BAD_URL`: the `<url>` argument is validated before the browser opens. Only `http` and
  `https` are accepted, so `file:`, `data:`, and the rest are refused rather than read off
  disk.
- A bare host is accepted and loaded over https, so `snipcode schema example.com` works instead
  of failing with a raw Playwright stack trace.
- `UNKNOWN_FLAG`: an unrecognized flag fails with a clear code instead of being ignored.
- `BAD_EXPECT_RECT`: `--expect-rect` is checked up front and reports this code when it is not
  JSON with all of `x`, `y`, `w`, `h` as numbers.
- Community and release setup: `CONTRIBUTING.md`, `SECURITY.md`, issue templates, a dependabot
  config, and a tag triggered release workflow.
- House rule checks in the test suite: the comment ceiling per directory, the 400 line module
  warning, and the dash ban.

### Changed

- Rewrote the README around the three commands, the error table, and the dev loop.
- Rewrote every module header and trimmed the comments across `core/src`. Both bundles stay byte
  identical, so no output changed.
- Collapsed duplicated helpers: one font src absolutizer, one css parser, one offscreen frame
  builder, and one stylesheet walker.

### Removed

- Node 18. CI runs on Node 20 and 22, and `engines.node` is now `>=20`. Node 18 reached end of
  life in April 2025 and cannot build the current Vite.

## [0.1.0] - 2026-07-24

First release.

### Added

- `snipcode candidates <url>`: inventories a page's targetable elements, each with a durable
  selector plus the text and rect used to verify it later, and writes a full-page screenshot.
- `snipcode extract <url> --selector "<css>"`: snips one element to a single self-contained
  artifact in `html`, `tailwind`, `jsx`, or `vue`. `--expect-text` and `--expect-rect` fail
  with `PAGE_SHIFTED` rather than snipping the wrong node. A site-builder page (Framer, Wix)
  is refused with the element's screenshot crop instead.
- `snipcode schema <url>`: a whole-page design reference, written as `schema.json` and
  `schema.md`. Design tokens, per-section layout measured from the rendered boxes, button,
  card, and nav blueprints, located background effects, and breakpoints.
- Claude Code skills for both flows, generated from `instructions/guidance.ts`.

### Notes

- Every command prints exactly one JSON object to stdout. Failures are
  `{ error: { code, message } }` with a nonzero exit code, so an agent never parses prose.
- Zero LLM calls and zero API keys. Every judgment layer stays with the calling agent.

[Unreleased]: https://github.com/micahtid/snipcode-plugin/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/micahtid/snipcode-plugin/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/micahtid/snipcode-plugin/releases/tag/v0.1.0
