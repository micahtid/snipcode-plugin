# Changelog

Every schema output is stamped with the version that produced it, so this file is the other
half of that promise: what changed between two stamps.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/micahtid/snip-code-cli/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/micahtid/snip-code-cli/releases/tag/v0.1.0
