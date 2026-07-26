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

/** Skill-priority rule, for the skills only: snipcode output is the authority, no competing skills. */
export const AUTHORITY = `While this skill is active it is the sole design authority. Do not load or follow other design
or styling skills (frontend-design, mobile-design, or similar) and do not apply your own aesthetic
preferences: they pull the output away from the source page. snipcode's output is measured from the
real rendered page; when your instinct and its values disagree, its values win.

Trust the current run's output over your own memory, notes from a prior session, or files an earlier
run left on disk. Each output carries the snipcode version and time it was generated. When a file on
disk is old or was written by a different version, run the command again rather than reuse it. A run
costs seconds and guarantees current output.`;

/** Install and first-run guidance, for the skill only: --help implies the CLI already runs. */
export const SETUP = `The CLI ships as the npm package 'snipcode'. If the command is missing, run it as
'npx snipcode' (or 'npm install -g snipcode' for a persistent install). The first run on a machine
also needs the browser: 'npx playwright install chromium' (a one-time download). A "command not
found" or a Playwright missing-browser error means one of these two steps, not a broken page.`;

/** The component-extraction flow, for the snip skill and top-level help. */
export const SNIP_FLOW = `Component-extraction flow ("extract the login button on <url>"):
  1. Run 'candidates <url>' to get an element inventory plus a screenshot.
  2. Pick the target by matching text, role, rect, or the screenshot. Note its 'selector',
     and its 'text' and 'rect' for drift verification.
  3. Run 'extract <url> --selector "<selector>"'. Pass --expect-text / --expect-rect from the
     candidate so a shifted page fails loudly instead of snipping the wrong node.
  4. The output is deterministic and pixel-correct. Your remaining job is judgment: see NAMING.

The flow is stateless: extract relaunches the browser and re-resolves the selector, so there is
no session to keep alive between commands.`;

/** The redesign flow, for the schema skill and top-level help. */
export const SCHEMA_FLOW = `Redesign flow ("redesign this page with reference to <url>"):
  1. Run 'schema <url>' to get design tokens and a layout map.
  2. Drop schema.md into your redesign prompt as the reference. See REDESIGN.`;

/** The overall three-command workflow, composed from the two flows for top-level help. */
export const WORKFLOW = `snipcode gives an agent SnipCode's two core features through three commands, all JSON in / JSON out:

  snipcode candidates <url>                 inventory a page's targetable elements
  snipcode extract <url> --selector "<css>" snip one element to clean, self-contained code
  snipcode schema <url>                     read a whole-page design reference

${SNIP_FLOW}

${SCHEMA_FLOW}`;

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
export const SCHEMA = `schema returns a whole-page design reference in two parts:
- tokens: color palette ranked by usage, font families and scale, spacing rhythm, radii, shadows.
- layout: a section blueprint (header, hero, cards, footer) with grid/flex, column counts, max-widths.
schema.md is a rendered summary you can drop straight into a redesign prompt. It is the schema and
nothing else; when you need a concrete sample of how the site composes its tokens, run extract on
one representative element.`;

/** Naming guidance, ported from the extension's byok polish prompt. The agent's job after extract. */
export const NAMING = `After extract, the markup and css are deterministic and pixel-correct but carry generated class
names (block__tag-n). Your judgment layer, all render-neutral, is:
- Rename generated classes to semantic ones. When an element has a base class plus a modifier
  (button + button--primary), rename both and keep both; never collapse them into one.
- Where an element's role is unambiguous and the change cannot alter rendering, promote its tag
  (a nav container to <nav>, a heading div to <h2>).
Never change declarations, sizes, colors, or geometry: those are already correct.`;

/** Redesign guidance for the schema-reference flow. */
export const REDESIGN = `When redesigning with a page as reference, the schema is a hard contract, not a soft starting point.
Follow it exactly. Use its exact token values (colors, type scale, spacing rhythm, radii, shadows),
never substitutes or "improved" alternatives. Reproduce its layout as measured: the section order,
the column counts, the max widths, and the way each section stacks. A section the schema marks
single-column stays a single column. It does not become two columns side by side just because that
is the common pattern for that kind of section. Do not add elements the schema does not show, even
familiar ones like a small label above a heading, and do not drop or reorder what it does show. Make
no assumptions from convention. An items count is a count: a section that reports 15 items gets 15,
at the size given, not a tidier number. The only part that is yours is the words: the copy and
content that fill the structure the schema gives you.

Read the gaps as gaps. A section typed \`content\`, a layout marked \`unknown (not measured)\`, and a
responsive field reading \`unknown\` are all the schema saying it did not measure that, not saying
the page is plain. Fill those with your own judgment, and do not read a type label as permission to
build the section the label usually implies: the element list and the item counts are the measured
facts, and the label is a name on top of them.`;

/** The standard placeholder icon for an empty image slot, referenced by RULES rule 6. */
export const PLACEHOLDER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`;

/** Universal quality rules for pages built from a schema. Soft defaults, the schema wins on conflict. */
export const RULES = `The schema gives you measured values. These rules cover what a schema cannot measure. They are
quality defaults, not a spec. They apply when you build a page from scratch. When the user already
has content, keep it as it is and change only what they ask you to change.

1. Rhythm applies everywhere. Use the schema's spacing scale between blocks, not just inside
   them. Every block needs deliberate breathing room from its neighbors. No two blocks should
   touch unless the source page shows they should.
2. Adapt to every viewport. The page must work at desktop, tablet, and phone widths. Content
   reflows or transforms. It never disappears or overflows.
3. Ship nothing unused. Every style rule, asset, script, and import in the output must earn its
   place. If it is not rendered or executed, it does not ship.
4. Structure is meaning. Use semantic markup and real text so the page reads correctly to
   machines as well as eyes.
5. Contrast is your check. The schema hands you a palette but not which color sits on which, so
   every pairing is yours to verify: text on its background, a control or input on the block behind
   it. When two schema colors are too close to read, use the nearest one in the palette that reads
   clearly. Never ship dark on dark or light on light.
6. Fill image slots. When a layout expects an image you do not have, draw a neutral placeholder
   sized to the slot: a filled block in a schema color one visible step lighter or darker than the
   surface behind it, with the icon below centered inside, plus a short label when it helps. Replace
   only the image, never the whole component around it. Do not invent CSS art, fake charts, or
   decorative shapes to stand in for a missing image, and never leave a bare white or empty gap.
   Keep the placeholder self-contained, so no external image service or remote URL. Use this icon
   exactly:
   ${PLACEHOLDER_ICON}
7. Write plain copy. When you generate text, keep it concise and in plain English. Say what the
   thing does. Avoid em dashes, and avoid filler that imitates marketing without meaning.
8. Precedence. The schema wins on anything it measures. These rules govern what it does not.
   When they conflict, favor the schema and use your judgment.`;

/** The guidance slice echoed inline on each command's json result. */
export const INLINE: Record<'candidates' | 'extract' | 'schema', string> = {
	candidates: 'Pick a target, then: snipcode extract <url> --selector "<selector>" --expect-text "<text>". See CANDIDATES.',
	extract: 'Output is deterministic and pixel-correct; your job is semantic naming and tags. See NAMING. If builderDetected, rebuild from element.png. See EXTRACT.',
	schema: 'The schema is a hard contract: match its tokens and layout exactly, and add nothing it does not show. See REDESIGN and RULES.',
};
