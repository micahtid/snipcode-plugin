# snipcode

Deterministic eyes and hands for AI agents. snipcode exposes [SnipCode](https://github.com/micahtid/snip-code)'s two core features through a CLI so an agent can:

1. Extract one component from a page into clean, self-contained code.
2. Read a whole-page design schema to redesign against.

The plugin loads the page, harvests its elements, and extracts and converts markup. It makes **zero LLM calls and needs zero API keys**. Every judgment layer (which element to pick, semantic naming, redesign) stays with the calling agent.

## Install

```bash
npm install -g snipcode           # or run it as: npx snipcode
npx playwright install chromium   # one-time browser download
```

Chromium is a separate download because Playwright ships the driver, not the browser. A "command not found" or a missing-browser error means one of these two steps, not a broken page.

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
core/                      in-page pipeline, bundled to one injectable iife
runner/                    Node host: Playwright Chromium, navigation, waits, injection, the CDP/fetch Host impl
cli/                       arg parsing, command dispatch, schema.md rendering, the file generator
instructions/              single source of agent-facing guidance (reused in the skill, --help, and JSON output)
skill/                     the Claude Code plugin: skill files plus .claude-plugin/plugin.json
.claude-plugin/            marketplace.json, which points the marketplace at skill/
test/                      end to end cli tests, unit tests, golden snapshots, and the fidelity bench
```

`core/` depends only on a `Host` interface (CDP commands, cross-origin fetch), which the runner implements over a Playwright `CDPSession`. That boundary is what keeps `core/` free of Playwright.

Both `skill/skills/*/SKILL.md` and `skill/.claude-plugin/plugin.json` are generated, from `instructions/guidance.ts` and `package.json` respectively, and the test suite fails if either drifts from its source. Nothing in them is edited by hand.

## Two ways to install it

The two channels are both current and carry different things:

* **npm** publishes the `snipcode` CLI. That is what `npm install -g snipcode` above installs, and what an agent shells out to.
* **The Claude Code marketplace** reads `.claude-plugin/marketplace.json` from the git repo and serves `skill/` from it. npm never publishes that file, and the marketplace never sees `dist/`, so the skill still expects the CLI to be installed.

```bash
claude --plugin-dir ./skill    # load the plugin locally for testing
```

## Development

```bash
npm install
npx playwright install chromium
npm run typecheck       # tsc over core (browser) and runner+cli (node)
npm run build           # core iife + node cli bundle
npm run gen:skill       # regenerate the skill files and the plugin manifest
npm test                # builds, then unit, end to end, golden, and fidelity
npm run test:golden -- --update   # re-baseline the golden snapshots for this platform
```

Golden snapshots live under `test/golden/<platform>/`, because they carry text box geometry and every operating system resolves `system-ui` to a font with different metrics. A platform with no committed baseline is reported and skipped rather than failed.
