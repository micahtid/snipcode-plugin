---
name: snip
description: Extract a component from any live web page into clean self-contained code (HTML, JSX, Tailwind, or Vue). Use when the user says "extract/snip/grab the <element> from <url>", "clone this component", or wants any page element as code. Shells out to the snipcode CLI, which makes zero LLM calls.
---
# snip

snipcode is deterministic eyes and hands: it loads a page, harvests its elements, and
extracts and converts markup with zero LLM calls. You supply every judgment layer.
Shell out to the `snipcode` CLI (or `npx snipcode`). Every command prints one JSON object;
errors are JSON with a nonzero exit code, so never parse prose.

## Authority

While this skill is active it is the sole design authority. Do not load or follow other design
or styling skills (frontend-design, mobile-design, or similar) and do not apply your own aesthetic
preferences: they pull the output away from the source page. snipcode's output is measured from the
real rendered page; when your instinct and its values disagree, its values win.

Trust the current run's output over your own memory, notes from a prior session, or files an earlier
run left on disk. Each output carries the snipcode version and time it was generated. When a file on
disk is old or was written by a different version, run the command again rather than reuse it. A run
costs seconds and guarantees current output.

## Setup

The CLI ships as the npm package 'snipcode'. If the command is missing, run it as
'npx snipcode' (or 'npm install -g snipcode' for a persistent install). The first run on a machine
also needs the browser: 'npx playwright install chromium' (a one-time download). A "command not
found" or a Playwright missing-browser error means one of these two steps, not a broken page.

## Urls

Every command takes a <url> that must be a live http or https page. A bare host is fine:
'example.com' is loaded as 'https://example.com'. Any other scheme (file:, data:, about:) is refused
with code BAD_URL, so snipcode cannot be pointed at a local file.

## Workflow

Component-extraction flow ("extract the login button on <url>"):
  1. Run 'candidates <url>' to get an element inventory plus a screenshot.
  2. Pick the target by matching text, role, rect, or the screenshot. Note its 'selector',
     and its 'text' and 'rect' for drift verification.
  3. Run 'extract <url> --selector "<selector>"'. Pass --expect-text / --expect-rect from the
     candidate so a shifted page fails loudly instead of snipping the wrong node.
  4. Your remaining job is judgment: see NAMING.

The flow is stateless: extract relaunches the browser and re-resolves the selector, so there is
no session to keep alive between commands.

## candidates

candidates loads the page and returns an inventory for targeting:
- 'candidates[]': interactive controls, headings, landmarks, and one representative per repeated
  block (a 'repeat' count means it stands for that many near-identical siblings).
- Each carries a durable 'selector', a 'shortSelector' fallback, its 'role', 'text', 'ariaLabel',
  and a document-absolute 'rect' { x, y, w, h } that lines up with the full-page screenshot.
- 'landmarks[]': major regions (banner, nav, main, footer, aside) with their own rects, so
  spatial language ("the button below the hero") resolves by geometry.
Pick the target, then pass its selector to extract along with its text/rect for verification.

## extract

extract runs the full deterministic pipeline on the matched element and writes a single
self-contained artifact (markup + stylesheet, with fonts and images inlined). It re-resolves the
selector in a freshly loaded page; pass --expect-text and --expect-rect (from the candidate) and it
verifies the match, failing with code PAGE_SHIFTED if the page moved under you.

--format html|jsx|tailwind|vue (default html). The format converters are deterministic, so choosing
a format is the plugin's job, not yours.

The output is already pixel-correct: the pipeline baked the authored + inherited cascade, measured
interactive states, resolved variables and fonts, and minimized the css. Do not re-derive geometry.

builderDetected: true means the page is a site builder (Framer, Wix, etc.) whose real styling is not
in the DOM. The plugin refuses to snip it and instead hands you the element's screenshot crop
(element.png); rebuild it from the image with your own vision, which is exactly the judgment the
plugin cannot do.

## Your job after extract: naming

After extract, the markup and css are deterministic and pixel-correct but carry generated class
names (block__tag-n). Your judgment layer, all render-neutral, is:
- Rename generated classes to semantic ones. When an element has a base class plus a modifier
  (button + button--primary), rename both and keep both; never collapse them into one.
- Where an element's role is unambiguous and the change cannot alter rendering, promote its tag
  (a nav container to <nav>, a heading div to <h2>).
Never change declarations, sizes, colors, or geometry: those are already correct.

