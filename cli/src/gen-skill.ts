/**
 * cli/src/gen-skill.ts: generate the Claude Code skill files from instructions/.
 *
 * The DRY rule: agent guidance lives once in instructions/guidance.ts. This composes
 * that guidance into skill/skills/{snip,schema}/SKILL.md, so the skills can never drift
 * from the CLI --help or the JSON guidance fields, which read the same source. The two
 * flows are separate skills so each trigger description stays sharp and each skill loads
 * only its own flow. Run via `npm run gen:skill` whenever the guidance changes.
 *
 * Composing and writing are separate. They used to be one step that ran on import, so the
 * only way to see the text the generator would produce was to let it rewrite the tracked
 * files. Editing guidance and forgetting to regenerate then shipped stale rules to every
 * agent reading the skill, with nothing to catch it. `composeSkills` returns the files
 * without touching disk, which is what lets the suite compare them to what is committed.
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

/** One composed skill file: where it belongs on disk and the text that belongs in it. */
export interface ComposedSkill {
	path: string;
	text: string;
}

/** Composes every skill file from the current guidance, writing nothing. */
export function composeSkills(): ComposedSkill[] {
	return SKILLS.map(({ name, description, sections }) => ({
		path: join(SKILLS_DIR, name, 'SKILL.md'),
		text: skillFile(name, description, sections),
	}));
}

/** Writes the composed skills to disk. Runs only when this module is the entry point. */
function writeSkills(): void {
	for (const { path, text } of composeSkills()) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
		process.stdout.write(`wrote ${path}\n`);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) writeSkills();
