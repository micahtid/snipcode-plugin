# SnipCode Agent Plugin: Planning

Goal: expose SnipCode's two core features to AI agents so an agent can handle:

1. "Extract the login button in https://www.facebook.com/" (component extraction)
2. "Redesign this webpage with reference to https://www.facebook.com/" (design schema / reference)

Division of labor, stated once and applied everywhere: **the plugin provides deterministic eyes and hands (load page, harvest data, extract and convert markup); the calling agent provides all judgment (picking elements, polish-style refinement, designing).** The plugin makes zero LLM calls and needs zero API keys.

## v1 scope

- **CLI** (`npx snipcode`): three commands, JSON in/out. Any agent can shell out to it; humans can script it.
- **Claude Code plugin**: a skill file that teaches the agent the workflow and carries the ported prompt guidance. No MCP server in v1; a CLI plus a skill is the whole integration for Claude Code, and other agents can wrap the same CLI.

Deferred to v2 (listed so we don't accidentally build them early):

- MCP server (thin wrapper over the same core functions, for clients that can't shell out).
- Auth-walled pages (likely a `--profile` flag reusing a persistent browser context).
- Multi-viewport / mobile capture.

## Command contract

All commands print a single JSON object to stdout. Errors are also JSON (`{ error: { code, message } }`) with a nonzero exit code, so agents never parse prose.

### `snipcode candidates <url>`

Loads the page and returns an element inventory for agent-driven targeting:

```json
{
  "viewport": { "width": 1440, "height": 900 },
  "screenshot": "candidates.png",
  "landmarks": [ { "role": "banner|hero|footer|...", "rect": {...} } ],
  "candidates": [
    {
      "id": "c12",
      "selector": "header form button[type=submit]",
      "tag": "button", "role": "button",
      "text": "Log In", "ariaLabel": null,
      "rect": { "x": 0, "y": 0, "w": 0, "h": 0 }
    }
  ]
}
```

- Candidates: interactive elements, landmarks, headings, and repeated structural blocks (cards, nav items).
- `selector` is a generated durable CSS selector. This is what makes the flow **stateless**: `extract` relaunches the browser and re-resolves the selector, so no session or daemon is needed. On re-resolution, `extract` verifies the match against the candidate's recorded text/rect and fails loudly if the page shifted, rather than silently extracting the wrong node.
- Spatial language ("below the hero") works because candidates and landmarks both carry rects; the agent does the geometry, or falls back to the screenshot.

### `snipcode extract <url> --selector "<css>" [--format html|jsx|tailwind|vue] [--out dir]`

Runs the extraction pipeline on the matched element. Output: `{ html, css, assets, meta }`, plus files written to `--out`.

`--format html|jsx|tailwind|vue` (default `html`): the converters in `convert/` are deterministic code, not LLM calls (verified: only `polish/` and `inspect/ai.ts` touch the LLM), so format conversion stays in the plugin. The agent's job is only the judgment layers: targeting, polish-style refinement, and redesign.

`meta.builderDetected`: the pipeline's builder-site gate (Framer etc.) is preserved. When it fires, output includes the element's screenshot crop so the agent can do the vision-model rebuild itself, which is exactly the role the vision pivot gave to an external model before.

### `snipcode schema <url> [--out dir]`

Whole-page design reference:

- **Tokens**: color palette grouped and ranked by usage, font families and scale, spacing rhythm, radii, shadows, borders.
- **Layout**: section map (header, hero, cards, footer) with structure notes (grid/flex, column counts, max-widths) and rects.
- **Voice**: a few representative component extractions (a button, a card, a nav item) reusing the extract machinery.
- Output: `schema.json`, full-page `screenshot.png`, and `schema.md` (rendered summary the agent can drop into a redesign prompt).

## Architecture

```
plugin/
  core/          in-page code, bundled to one injectable IIFE:
                 extraction pipeline (ported from chrome-extension/src/content),
                 candidate harvest, schema walk
  runner/        Node host: Playwright headless Chromium, navigation, waits,
                 injection, CDP screenshots, output writing
  cli/           arg parsing + command dispatch (thin; all logic in core/runner)
  instructions/  single source of agent-facing guidance (see below)
  skill/         Claude Code plugin manifest + skill file (generated from instructions/)
```

Key insight: the existing pipeline runs in-page as a content script against a live DOM. The runner reproduces that by injecting the same bundled code into a Playwright page.

**Pipeline split (verified against the code).** The real pipeline is capture -> reconcile -> resolve -> convert -> polish (`content/index.ts`). Everything except `polish/` is deterministic and ports into `core/`. Dropped from the port: `polish/` (LLM refinement, becomes skill instructions), `inspect/ai.ts` and `assistive/` extension-UI features, `capture/picker.ts` (human click targeting, replaced by `--selector`), `llm.ts`. The prompts move, they don't disappear.

**Host interface (the port boundary, verified).** All `chrome.*` usage in the content code is a messaging bridge to the background worker for exactly four services. Define one `Host` interface with those four methods and the port is mechanical:

| Service | Extension impl | Plugin impl |
|---|---|---|
| CDP commands (cross-origin sheets/fonts, inherited chain, interactive states) | `chrome.debugger` via background | Playwright `CDPSession` |
| Cross-origin asset fetch (`resolve/inline.ts`) | background fetch | Node `fetch` |
| Screenshot | `chrome.tabs.captureVisibleTab` | CDP `Page.captureScreenshot` |
| LLM (`llm.ts`) | background proxy | not implemented (agent's job) |

`core/` depends only on `Host`, which is what makes it promotable to `@snipcode/core` later.

**DRY rule for instructions.** All agent-facing guidance lives once in `instructions/` and is reused in three places: the skill file, CLI `--help`, and inline `guidance` fields in JSON output. No copy-pasted prompt text across layers.

## Page loading defaults (runner)

- Viewport 1440x900, desktop UA.
- Wait: load event, network idle, fonts ready; then one scroll-to-bottom pass to trigger lazy content, then scroll back.
- Known hazards, handled by failing informatively rather than guessing: bot walls and consent banners (return a `blocked` error with a screenshot so the agent can see what happened and tell the user), infinite-scroll pages (capture what the default pass loaded).

## Build phases

1. **Copy + build the core** (decided): copy capture/reconcile/resolve/convert (plus `types.ts`) from `chrome-extension/src/content` into `core/`, replace the `chrome.runtime` messaging with the `Host` interface, and bundle as one injectable IIFE (Vite lib build). Parity check: same element via extension and via CLI yields the same output. `core/` is written to become the shared `@snipcode/core` package later (no extension imports, no plugin-specific hacks inside it); the extension switches to consuming it once the plugin proves out.
2. **Runner**: Playwright wrapper implementing `Host` (CDPSession, fetch, screenshots), waits, injection, JSON/file output.
3. **`candidates`**: harvest + durable selector generation + re-resolution verification.
4. **`extract`**: wire pipeline to selector, `--format`, `--out`, error contract.
5. **`schema`**: tokens, layout map, representative components.
6. **Instructions + skill**: port prompt templates into `instructions/`, generate skill file, write the Claude Code plugin manifest.
7. **Bench**: reuse the existing fidelity harness pattern (`testing/run-fidelity.ts`) against the CLI path; one regression run at the end, per the cost rule.

## Decisions (previously open questions)

- **Placement**: lives in `plugin/` in this folder for now; new repo only if/when published.
- **Distribution**: npm, `npx snipcode`. Playwright's Chromium download is the only heavy dependency; document it.
- **Auth pages**: v2. v1 returns the `blocked` error honestly.
- **Code sharing with the extension**: copy now, but write `core/` as a clean standalone module from day one so it can be promoted to a shared `@snipcode/core` workspace package without rework. The copy in the extension stays untouched until then.
