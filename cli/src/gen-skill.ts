/**
 * cli/src/gen-skill.ts: generate the plugin's committed files from their one source.
 *
 * Agent guidance lives once in instructions/guidance.ts, and this composes it into
 * skill/skills/{snip,schema}/SKILL.md, so the skills can never drift from the CLI --help or
 * the JSON guidance fields, which read the same source. The two flows are separate skills so
 * each trigger description stays sharp and each loads only its own flow.
 *
 * The plugin manifest is generated the same way, from package.json, because the version was
 * hand written in both and the schema stamp exists precisely so an agent can spot a stale
 * file. Run via `npm run gen:skill` whenever the guidance or package.json changes.
 *
 * Composing and writing are separate. They used to be one step that ran on import, so the
 * only way to see the text the generator would produce was to let it rewrite the tracked
 * files. Editing guidance and forgetting to regenerate then shipped stale rules to every
 * agent reading the skill, with nothing to catch it. `composeSkills` returns the files
 * without touching disk, which is what lets the suite compare them to what is committed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AUTHORITY, SETUP, SNIP_FLOW, SCHEMA_FLOW, CANDIDATES, EXTRACT, SCHEMA, NAMING, REDESIGN, RULES } from '../../instructions/guidance';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS_DIR = join(ROOT, 'skill', 'skills');
const MANIFEST_PATH = join(ROOT, 'skill', '.claude-plugin', 'plugin.json');

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

/** The description the marketplace and the plugin manifest both show. */
const PLUGIN_DESCRIPTION =
	'Extract a component from any live web page into clean self-contained code, or read a whole-page design schema. Deterministic, zero LLM calls.';

/** The keywords the plugin manifest carries, which are the marketplace's, not npm's. */
const PLUGIN_KEYWORDS = [
	'component extraction', 'design tokens', 'design system', 'design schema',
	'clone component', 'redesign', 'web to code', 'html', 'react', 'tailwind', 'vue', 'css',
];

/** The fields the plugin manifest copies straight from package.json. */
interface PackageFields {
	version: string;
	author: { name: string; url: string };
	homepage: string;
	repository: { url: string };
	license: string;
}

/**
 * The plugin manifest, built from package.json.
 *
 * The version used to be hand written here as well as in package.json and core/src/entry.ts.
 * On the first bump the manifest would have kept reporting the old number, and the schema
 * stamp an agent reads to spot a stale file would have been the thing that was stale.
 */
function pluginManifest(): string {
	const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as PackageFields;
	const manifest = {
		name: 'snipcode',
		version: pkg.version,
		description: PLUGIN_DESCRIPTION,
		author: pkg.author,
		homepage: pkg.homepage,
		// package.json carries the git+ prefixed clone url; the manifest wants the page.
		repository: pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, ''),
		license: pkg.license,
		keywords: PLUGIN_KEYWORDS,
	};
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** One generated file: where it belongs on disk and the text that belongs in it. */
export interface ComposedFile {
	path: string;
	text: string;
}

/** Composes every generated file from its source, writing nothing. */
export function composeSkills(): ComposedFile[] {
	return [
		...SKILLS.map(({ name, description, sections }) => ({
			path: join(SKILLS_DIR, name, 'SKILL.md'),
			text: skillFile(name, description, sections),
		})),
		{ path: MANIFEST_PATH, text: pluginManifest() },
	];
}

/** Writes the composed files to disk. Runs only when this module is the entry point. */
function writeSkills(): void {
	for (const { path, text } of composeSkills()) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
		process.stdout.write(`wrote ${path}\n`);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) writeSkills();
