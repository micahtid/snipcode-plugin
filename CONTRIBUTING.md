# Contributing

Thanks for looking. Bugs, fixes, and new fidelity cases are all welcome.

## The dev loop

The README's [Developing](./README.md#developing) section has the setup and the commands. The
short version:

```bash
npm install
npx playwright install chromium
npm run verify          # typecheck, build, unit, end to end, golden, fidelity
```

`npm run verify` is exactly what CI runs, so a green local run means a green pull request.

## House rules

The test suite enforces these, so a pull request that breaks one fails before review.

- **No em dashes or en dashes**, in source or in agent-facing text. Use a comma, a colon, or
  two sentences.
- **A comment share ceiling per directory.** `core/src` is the tightest. Adding a large comment
  block can push a directory over its ceiling; tighten the prose rather than raising the limit.
- **A size warning at 400 lines** on any shipped module, and a hard failure at 500. The warning
  is the useful one: it catches a module doing two jobs while splitting it is still cheap.
- **Every module must be reachable** from an entry point. Dead files fail the suite.
- **Skill files are generated.** `skill/skills/*/SKILL.md` and `skill/.claude-plugin/plugin.json`
  come from `instructions/guidance.ts` and `package.json`. Edit the source, then run
  `npm run gen:skill`. The suite fails if either drifts.

## Changing comments only

There is a tool for that. Both bundles are minified, so a comment-only edit must produce
byte-identical output:

```bash
npm run verify:comments -- --record   # before the pass
npm run verify:comments               # after
```

A moved hash means code changed by mistake.

## Golden snapshots

`test/golden/<platform>/` holds per-platform baselines, because every operating system resolves
`system-ui` to a font with different metrics. A platform with no committed baseline is reported
and skipped rather than failed.

If a change moves the output on purpose, refresh your own platform with
`npm run test:golden -- --update`. The linux baselines can only be built on linux, so ask a
maintainer to dispatch the `refresh_goldens` workflow and commit the artifact.

## Pull requests

- One change per pull request, with the reason in the description.
- Keep the commit subject in the Conventional Commits style the history already uses:
  `fix(core): ...`, `feat(cli): ...`, `docs: ...`.
- If you found a real page the pipeline gets wrong, a fixture in `test/fixtures/` that
  reproduces it is worth more than the fix.
