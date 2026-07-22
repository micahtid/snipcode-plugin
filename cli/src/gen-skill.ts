/**
 * cli/src/gen-skill.ts: generate the Claude Code skill file from instructions/.
 *
 * The DRY rule: agent guidance lives once in instructions/guidance.ts. This composes
 * that guidance into skill/skills/snipcode/SKILL.md, so the skill can never drift from
 * the CLI --help or the JSON guidance fields, which read the same source. Run via
 * `npm run gen:skill` whenever the guidance changes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WORKFLOW, CANDIDATES, EXTRACT, SCHEMA, NAMING, REDESIGN } from '../../instructions/guidance';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL_DIR = join(ROOT, 'skill', 'skills', 'snipcode');

/** The skill file: yaml frontmatter Claude reads to auto-invoke, then the ported guidance. */
function skillFile(): string {
	const frontmatter = [
		'---',
		'name: snipcode',
		'description: Extract a component from any live web page into clean self-contained code, or read a whole-page design schema to redesign against. Use when the user says "extract/snip/grab the <element> from <url>", "clone this component", "redesign this page like <url>", or wants a site\'s design tokens. Shells out to the snipcode CLI, which makes zero LLM calls.',
		'---',
		'',
	].join('\n');

	const body = [
		'# snipcode',
		'',
		'snipcode is deterministic eyes and hands: it loads a page, harvests its elements, and',
		'extracts and converts markup with zero LLM calls. You supply every judgment layer.',
		'Shell out to the `snipcode` CLI (or `npx snipcode`). Every command prints one JSON object;',
		'errors are JSON with a nonzero exit code, so never parse prose.',
		'',
		'## Workflow',
		'',
		WORKFLOW,
		'',
		'## candidates',
		'',
		CANDIDATES,
		'',
		'## extract',
		'',
		EXTRACT,
		'',
		'## schema',
		'',
		SCHEMA,
		'',
		'## Your job after extract: naming',
		'',
		NAMING,
		'',
		'## Your job for a redesign',
		'',
		REDESIGN,
		'',
	].join('\n');

	return `${frontmatter}${body}\n`;
}

mkdirSync(SKILL_DIR, { recursive: true });
const path = join(SKILL_DIR, 'SKILL.md');
writeFileSync(path, skillFile());
process.stdout.write(`wrote ${path}\n`);
