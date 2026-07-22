/**
 * instructions/guidance.ts: the single source of agent-facing guidance.
 *
 * The plan's DRY rule: all agent-facing prose lives here once and is reused in three
 * places, never copy-pasted. The cli prints it in --help and echoes the relevant slice
 * as a `guidance` field on every json result; gen-skill.ts composes it into the Claude
 * Code SKILL.md. Editing guidance means editing this file only.
 *
 * The division of labor, stated once: the plugin is deterministic eyes and hands (load a
 * page, harvest its elements, extract and convert markup); the agent provides every
 * judgment layer (which element, polish-style naming, redesign). The plugin makes zero
 * llm calls. The naming and redesign notes below are the prompt guidance that used to
 * live in the extension's byok polish and the marketing-site generation templates,
 * ported here because that judgment is now the agent's.
 */

/** The overall three-command workflow, for the skill and top-level help. */
export const WORKFLOW = `snipcode gives an agent SnipCode's two core features through three commands, all JSON in / JSON out:

  snipcode candidates <url>                 inventory a page's targetable elements
  snipcode extract <url> --selector "<css>" snip one element to clean, self-contained code
  snipcode schema <url>                     read a whole-page design reference

Component-extraction flow ("extract the login button on <url>"):
  1. Run 'candidates <url>' to get an element inventory plus a screenshot.
  2. Pick the target by matching text, role, rect, or the screenshot. Note its 'selector',
     and its 'text' and 'rect' for drift verification.
  3. Run 'extract <url> --selector "<selector>"'. Pass --expect-text / --expect-rect from the
     candidate so a shifted page fails loudly instead of snipping the wrong node.
  4. The output is deterministic and pixel-correct. Your remaining job is judgment: see NAMING.

Redesign flow ("redesign this page with reference to <url>"):
  1. Run 'schema <url>' to get design tokens, a layout map, and a few real component samples.
  2. Drop schema.md into your redesign prompt as the reference. See REDESIGN.

The flow is stateless: extract relaunches the browser and re-resolves the selector, so there is
no session to keep alive between commands.`;

/** candidates command guidance. */
export const CANDIDATES = `candidates loads the page and returns an inventory for targeting:
- 'candidates[]': interactive controls, headings, landmarks, and one representative per repeated
  block (a 'repeat' count means it stands for that many near-identical siblings).
- Each carries a durable 'selector', a 'shortSelector' fallback, its 'role', 'text', 'ariaLabel',
  and a document-absolute 'rect' { x, y, w, h } that lines up with the full-page screenshot.
- 'landmarks[]': major regions (banner, nav, main, footer, aside) with their own rects, so
  spatial language ("the button below the hero") resolves by geometry.
Pick the target, then pass its selector to extract along with its text/rect for verification.`;

/** extract command guidance, including the builder-gate path. */
export const EXTRACT = `extract runs the full deterministic pipeline on the matched element and writes a single
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
plugin cannot do.`;

/** schema command guidance. */
export const SCHEMA = `schema returns a whole-page design reference in three parts:
- tokens: color palette ranked by usage, font families and scale, spacing rhythm, radii, shadows.
- layout: a section blueprint (header, hero, cards, footer) with grid/flex, column counts, max-widths.
- voice: a few real component extractions (a button, a card, a nav item) run through the same
  extract pipeline, so you get concrete samples of how the site composes its tokens.
schema.md is a rendered summary you can drop straight into a redesign prompt.`;

/** Naming guidance, ported from the extension's byok polish prompt. The agent's job after extract. */
export const NAMING = `After extract, the markup and css are deterministic and pixel-correct but carry generated class
names (block__tag-n). Your judgment layer, all render-neutral, is:
- Rename generated classes to semantic ones. When an element has a base class plus a modifier
  (button + button--primary), rename both and keep both; never collapse them into one.
- Where an element's role is unambiguous and the change cannot alter rendering, promote its tag
  (a nav container to <nav>, a heading div to <h2>).
- Add short grouping comments before rules in plain English.
Never change declarations, sizes, colors, or geometry: those are already correct.`;

/** Redesign guidance for the schema-reference flow. */
export const REDESIGN = `When redesigning with a page as reference, treat the schema as the design system, not a layout to
copy. Reuse its tokens (colors, type scale, spacing rhythm, radii, shadows) and its structural
patterns (section order, column counts, max-widths). The voice samples show how the site composes
those tokens into real components; match that composition style rather than cloning the markup.`;

/** The guidance slice echoed inline on each command's json result. */
export const INLINE: Record<'candidates' | 'extract' | 'schema', string> = {
	candidates: 'Pick a target, then: snipcode extract <url> --selector "<selector>" --expect-text "<text>". See CANDIDATES.',
	extract: 'Output is deterministic and pixel-correct; your job is semantic naming and tags. See NAMING. If builderDetected, rebuild from element.png. See EXTRACT.',
	schema: 'Use tokens + layout + voice as a design system, not a layout to clone. See REDESIGN.',
};
