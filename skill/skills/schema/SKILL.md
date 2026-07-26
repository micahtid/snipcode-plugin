---
name: schema
description: Read a whole-page design schema (design tokens and layout blueprint) to redesign against. Use when the user says "redesign this page like <url>", "match this site's style", or wants a site's design tokens, colors, or fonts. Shells out to the snipcode CLI, which makes zero LLM calls.
---
# schema

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

## Workflow

Redesign flow ("redesign this page with reference to <url>"):
  1. Run 'schema <url>' to get design tokens and a layout map.
  2. Drop schema.md into your redesign prompt as the reference. See REDESIGN.

## schema

schema returns a whole-page design reference in two parts:
- tokens: color palette ranked by usage, font families and scale, spacing rhythm, radii, shadows.
- layout: a section blueprint (header, hero, cards, footer) with grid/flex, column counts, max-widths.
schema.md is a rendered summary you can drop straight into a redesign prompt. It is the schema and
nothing else; when you need a concrete sample of how the site composes its tokens, run extract on
one representative element.

## Your job for a redesign

When redesigning with a page as reference, the schema is a hard contract, not a soft starting point.
Follow it exactly. Use its exact token values (colors, type scale, spacing rhythm, radii, shadows),
never substitutes or "improved" alternatives. Reproduce its layout as measured: the section order,
the column counts, the max widths, and the way each section stacks. A section the schema marks
single-column stays a single column. It does not become two columns side by side just because that
is the common pattern for that kind of section. Do not add elements the schema does not show, even
familiar ones like a small label above a heading, and do not drop or reorder what it does show. Make
no assumptions from convention. An items count is a count: a section that reports 15 items gets 15,
at the size given, not a tidier number. The only part that is yours is the words: the copy and
content that fill the structure the schema gives you.

Read the gaps as gaps. A section typed `content`, a layout marked `unknown (not measured)`, and a
responsive field reading `unknown` are all the schema saying it did not measure that, not saying
the page is plain. Fill those with your own judgment, and do not read a type label as permission to
build the section the label usually implies: the element list and the item counts are the measured
facts, and the label is a name on top of them.

## Rules

The schema gives you measured values. These rules cover what a schema cannot measure. They are
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
5. Fill image slots. When a layout expects an image you do not have, draw a neutral placeholder
   sized to the slot: a filled block in a schema color with the icon below centered inside, plus a
   short label when it helps. Replace only the image, never the whole component around it. Do not
   invent CSS art, fake charts, or decorative shapes to stand in for a missing image, and never
   leave a bare white or empty gap. Keep the placeholder self-contained, so no external image
   service or remote URL. Use this icon exactly:
   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
6. Write plain copy. When you generate text, keep it concise and in plain English. Say what the
   thing does. Avoid em dashes, and avoid filler that imitates marketing without meaning.
7. Precedence. The schema wins on anything it measures. These rules govern what it does not.
   When they conflict, favor the schema and use your judgment.

