/**
 * cli/src/gen-skill.ts: generate the Claude Code skill files from instructions/.
 *
 * The DRY rule: agent guidance lives once in instructions/guidance.ts. This composes
 * that guidance into skill/skills/{snip,schema}/SKILL.md, so the skills can never drift
 * from the CLI --help or the JSON guidance fields, which read the same source. The two
 * flows are separate skills so each trigger description stays sharp and each skill loads
 * only its own flow. Run via `npm run gen:skill` whenever the guidance changes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AUTHORITY, SETUP, SNIP_FLOW, SCHEMA_FLOW, CANDIDATES, EXTRACT, SCHEMA, NAMING, REDESIGN, RULES } from '../../instructions/guidance';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS_DIR = join(ROOT, 'skill', 'skills');

/** The shared intro: what snipcode is and the JSON contract, identical in both skills. */
const INTRO = [
	'snipcode is deterministic eyes and hands: it loads a page, harvests its elements, and',
	'extracts and converts markup with zero LLM calls. You supply every judgment layer.',
	'Shell out to the `snipcode` CLI (or `npx snipcode`). Every command prints one JSON object;',
	'errors are JSON with a nonzero exit code, so never parse prose.',
];

/** A skill file: yaml frontmatter Claude reads to auto-invoke, then the ported guidance. */
function skillFile(name: string, description: string, sections: [title: string, body: string][]): string {
	const frontmatter = ['---', `name: ${name}`, `description: ${description}`, '---', ''].join('\n');
	const body = [
		`# ${name}`,
		'',
		...INTRO,
		'',
		'## Authority',
		'',
		AUTHORITY,
		'',
		'## Setup',
		'',
		SETUP,
		...sections.flatMap(([title, text]) => ['', `## ${title}`, '', text]),
		'',
	].join('\n');
	return `${frontmatter}${body}\n`;
}

const SKILLS: { name: string; description: string; sections: [string, string][] }[] = [
	{
		name: 'snip',
		description:
			'Extract a component from any live web page into clean self-contained code (HTML, JSX, Tailwind, or Vue). Use when the user says "extract/snip/grab the <element> from <url>", "clone this component", or wants any page element as code. Shells out to the snipcode CLI, which makes zero LLM calls.',
		sections: [
			['Workflow', SNIP_FLOW],
			['candidates', CANDIDATES],
			['extract', EXTRACT],
			['Your job after extract: naming', NAMING],
		],
	},
	{
		name: 'schema',
		description:
			'Read a whole-page design schema (design tokens and layout blueprint) to redesign against. Use when the user says "redesign this page like <url>", "match this site\'s style", or wants a site\'s design tokens, colors, or fonts. Shells out to the snipcode CLI, which makes zero LLM calls.',
		sections: [
			['Workflow', SCHEMA_FLOW],
			['schema', SCHEMA],
			['Your job for a redesign', REDESIGN],
			['Rules', RULES],
		],
	},
];

for (const { name, description, sections } of SKILLS) {
	const dir = join(SKILLS_DIR, name);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'SKILL.md');
	writeFileSync(path, skillFile(name, description, sections));
	process.stdout.write(`wrote ${path}\n`);
}
