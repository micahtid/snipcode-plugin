/**
 * cli/src/index.ts: argument parsing and command dispatch.
 *
 * Thin by design: parse argv into Args, dispatch to one of the three commands, and
 * let it own its JSON output. All real logic lives in the runner and core; all
 * guidance lives in instructions/. Errors from a missing url or unknown command are
 * reported through the same JSON error contract as runtime failures.
 */
import { runCandidates, runExtract, runSchema, type Args } from './commands';
import { emitError, normalizeUrl, FORMAT_NAMES } from './output';
import { WORKFLOW, URLS, CANDIDATES, EXTRACT, SCHEMA, NAMING, REDESIGN, RULES } from '../../instructions/guidance';

/**
 * The package version. Substituted from package.json by the bundler, see
 * vite.node.config.ts, so `snipcode --version` can never drift from what npm installed.
 */
const VERSION = __SNIPCODE_VERSION__;

const HELP = `snipcode ${VERSION}: deterministic eyes and hands for AI agents

${WORKFLOW}

Commands:
  candidates <url>                        inventory a page's targetable elements
  extract <url> --selector "<css>"        snip one element to clean, self-contained code
  schema <url>                            read a whole-page design reference

Options:
  --selector "<css>"     (extract) the element to snip
  --format <fmt>         (extract) one of: ${FORMAT_NAMES.join(', ')}  [default html]
  --out <dir>            output directory for files  [default ./snipcode-out]
  --expect-text "<t>"    (extract) recorded candidate text, for drift verification
  --expect-rect "<json>" (extract) recorded candidate rect {x,y,w,h}, for drift verification
  --headed               run the browser headed (debugging)
  --help, --version

${URLS}

Guidance:
${CANDIDATES}

${EXTRACT}

${SCHEMA}

${NAMING}

${REDESIGN}

${RULES}
`;

/** The flags that take a value, mapped to the Args field each one fills. */
const VALUE_FLAGS: Record<string, keyof Args> = {
	'--selector': 'selector',
	'--format': 'format',
	'--out': 'out',
	'--expect-text': 'expectText',
	'--expect-rect': 'expectRect',
};

/**
 * Parse argv (after the command and url) into the flag bag. Value flags consume the next token.
 *
 * An unrecognized flag is an error, not a shrug. It used to be ignored so that a future flag
 * would not hard-fail an older cli. But the cli and the skill ship in one package and upgrade
 * together, so there is no such pairing. What it actually did was turn `--selctor "#login"`
 * into a confusing MISSING_SELECTOR, and a mistyped `--format` into a silent default.
 */
function parseFlags(rest: string[]): { args: Partial<Args> } | { error: string } {
	const args: Partial<Args> = {};
	for (let i = 0; i < rest.length; i++) {
		const flag = rest[i]!;
		const field = VALUE_FLAGS[flag];
		if (field) {
			const value = rest[i + 1];
			if (value === undefined) return { error: `${flag} needs a value` };
			args[field] = value as never;
			i++;
			continue;
		}
		if (flag === '--headed') {
			args.headed = true;
			continue;
		}
		return { error: `unknown flag "${flag}"; expected one of: ${[...Object.keys(VALUE_FLAGS), '--headed'].join(', ')}` };
	}
	return { args };
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
		process.stdout.write(HELP);
		return;
	}
	if (argv[0] === '--version' || argv[0] === '-v') {
		process.stdout.write(`${VERSION}\n`);
		return;
	}

	const command = argv[0];
	const raw = argv[1];
	if (!raw || raw.startsWith('--')) {
		emitError('MISSING_URL', `${command} requires a <url> as its first argument`);
		return;
	}
	let url: string;
	try {
		url = normalizeUrl(raw);
	} catch (err) {
		emitError('BAD_URL', (err as Error).message);
		return;
	}
	const parsed = parseFlags(argv.slice(2));
	if ('error' in parsed) {
		emitError('UNKNOWN_FLAG', parsed.error);
		return;
	}
	const args: Args = { url, ...parsed.args };

	switch (command) {
		case 'candidates': await runCandidates(args); break;
		case 'extract': await runExtract(args); break;
		case 'schema': await runSchema(args); break;
		default:
			emitError('UNKNOWN_COMMAND', `unknown command "${command}"; expected candidates, extract, or schema`);
	}
}

main().catch((err) => {
	emitError('FATAL', (err as Error).message);
	process.exitCode = 1;
});
