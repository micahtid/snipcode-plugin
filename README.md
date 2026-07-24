# snipcode

Deterministic eyes and hands for AI agents. snipcode exposes [SnipCode](https://github.com/micahtid/snip-code)'s two core features through a CLI so an agent can:

1. Extract one component from a page into clean, self-contained code.
2. Read a whole-page design schema to redesign against.

The plugin loads the page, harvests its elements, and extracts and converts markup. It makes **zero LLM calls and needs zero API keys**. Every judgment layer (which element to pick, semantic naming, redesign) stays with the calling agent.

## Install

```bash
npm install
npx playwright install chromium   # one-time browser download
npm run build
```

## Commands

All commands print one JSON object to stdout. Errors are JSON too (`{ error: { code, message } }`) with a nonzero exit code, so an agent never parses prose. File side effects land under `--out` (default `./snipcode-out`).

### `snipcode candidates <url>`

Inventory a page's targetable elements: interactive controls, headings, landmarks, and one representative per repeated block. Each carries a durable selector plus the text and rect used to verify it later. A full-page screenshot is written alongside.

### `snipcode extract <url> --selector "<css>" [--format html|jsx|tailwind|vue] [--out dir]`

Snip the matched element to a single self-contained artifact (markup + stylesheet, fonts and images inlined). Pass `--expect-text` / `--expect-rect` from the candidate and extract verifies the match, failing with `PAGE_SHIFTED` if the page moved. When the page is a site builder (Framer, Wix, etc.) the pipeline refuses and hands back the element's screenshot crop for the agent to rebuild from.

### `snipcode schema <url> [--out dir]`

Whole-page design reference: design tokens (colors, fonts, spacing, radii, shadows) and a layout blueprint. Writes `schema.json` and `schema.md`, each stamped with the snipcode version and generation time so a stale file is easy to spot.

## Architecture

```
core/          in-page pipeline, ported from the SnipCode extension, bundled to one injectable iife
runner/        Node host: Playwright Chromium, navigation, waits, injection, the CDP/fetch Host impl
cli/           arg parsing + command dispatch
instructions/  single source of agent-facing guidance (reused in the skill, --help, and JSON output)
skill/         Claude Code plugin manifest + skill file
```

`core/` depends only on a `Host` interface (CDP commands, cross-origin fetch), which the runner implements over a Playwright `CDPSession`. That boundary is what keeps `core/` promotable to a shared `@snipcode/core` package.

## Claude Code plugin

A Claude Code skill wraps the CLI so an agent picks it up automatically. The skill file is generated from `instructions/` (one source of guidance, reused in the skill, `--help`, and JSON output):

```bash
npm run gen:skill              # regenerate skill/skills/{snip,schema}/SKILL.md
claude --plugin-dir ./skill    # load the plugin locally for testing
```

## Development

```bash
npm run typecheck       # tsc over core (browser) and runner+cli (node)
npm run build           # core iife + node cli bundle
npm test                # builds, then runs the end to end cli tests
npm run test:fidelity   # renders an extract and pixel-compares it to the live element
```
