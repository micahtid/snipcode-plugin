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

schema returns a whole-page design reference in three parts:
- tokens: color palette ranked by usage, font families and scale, spacing rhythm, radii, shadows.
- layout: every section in order, each with its measured layout, column count and ratio, max width,
  background, ordered element list, and the count and size of the items it repeats.
- components: the button, card, and nav specs, the page's breakpoints, and each decorative effect
  with the section it was measured in.
schema.md is a rendered summary you can drop straight into a redesign prompt. It is the schema and
nothing else; when you need a concrete sample of how the site composes its tokens, run extract on
one representative element.

## Your job for a redesign

When redesigning with a page as reference, the schema is a hard contract, not a soft starting point.
It binds at two levels: its design language in every use, and its page-level arrangement when you
are rebuilding the reference page.

Hard in every use:
- Token values. Its colors, type scale, spacing rhythm, radii, and shadows exactly, never
  substitutes or "improved" alternatives.
- Component specs. A button, card, or nav you build is the one the schema measured, down to its
  fill, radius, padding, border, and shadow.
- The internal shape of every section you use: its element list, its measured layout pattern, its
  columns and ratio, and its items line. A section marked single-column stays a single column. It
  does not become two columns side by side because that is the common pattern for its kind. An
  items count is a count: a section reporting 15 items gets 15, at the size given, not a tidier
  number.

The page-level arrangement, meaning which sections exist and what order they run in, is hard only
when you are rebuilding the reference page itself. That is the default: with no structure of the
user's own in play, reproduce the reference's arrangement exactly. When the user brings their own
page or describes their own structure, that arrangement is theirs. Do not reorder it, drop from it,
or add the reference's sections to it. Build every section they do use to its measured shape, in
the schema's tokens and component specs. They are asking for this page's design language on their
structure, not for this page.

A section's element list is complete. An element the list does not name does not exist in that
section, however conventional it looks there, such as a small label above a heading. Adding one is
drift twice over: it was not on the page, and the schema holds no spec for it, so its color, radius,
and padding can only be guessed, which is the guesswork the schema exists to replace. Do not drop or
reorder what the list does show. The only part that is yours is the words: the copy and content that
fill the structure the schema gives you.

A decorative effect names the section it was measured in, as `gradient (hero)`. Use it in that
section and nowhere else. A section's own `bg` line is the whole of its background.

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
5. Contrast is your check. The schema hands you a palette but not which color sits on which, so
   every pairing is yours to verify: text on its background, a control or input on the block behind
   it. When two schema colors are too close to read, use the nearest one in the palette that reads
   clearly. Never ship dark on dark or light on light.
6. Fill image slots. When a layout expects an image you do not have, draw a neutral placeholder
   sized to the slot: a filled block in the nearest schema color that reads as separate from the
   surface behind it, with the icon below centered inside, plus a short label when it helps. Replace
   only the image, never the whole component around it. The placeholder stands in for the image
   the schema listed, so it is not an element the list does not name. Do not invent CSS art, fake
   charts, or decorative shapes to stand in for a missing image, and never leave a bare white or
   empty gap.
   Keep the placeholder self-contained, so no external image service or remote URL. Use this icon
   exactly:
   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
7. Build only what the schema specifies. When it names something but gives you no values to build
   that thing with, leave the thing out. An effect it places in a section but never specifies is
   one you do not paint, and a shade near the palette but not in it is one you do not mix. This is
   not the same as silence. Where the schema measured nothing and the page still needs an answer,
   your judgment fills it, as in rules 5 and 6.
8. Write plain copy. When you generate text, keep it concise and in plain English. Say what the
   thing does. Avoid em dashes, and avoid filler that imitates marketing without meaning.
9. Precedence. The schema wins on anything it measures. These rules govern what it does not.
   When they conflict, favor the schema and use your judgment.

