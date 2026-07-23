/**
 * cli/src/index.ts: argument parsing and command dispatch.
 *
 * Thin by design: parse argv into Args, dispatch to one of the three commands, and
 * let it own its JSON output. All real logic lives in the runner and core; all
 * guidance lives in instructions/. Errors from a missing url or unknown command are
 * reported through the same JSON error contract as runtime failures.
 */
import { runCandidates, runExtract, runSchema, type Args } from './commands';
import { emitError, FORMAT_NAMES } from './output';
import { WORKFLOW, CANDIDATES, EXTRACT, SCHEMA, NAMING, REDESIGN } from '../../instructions/guidance';

/**
 * The package version. Substituted from package.json by the bundler, see
 * vite.node.config.ts, so `snipcode --version` can never drift from what npm installed.
 */
const VERSION = __SNIPCODE_VERSION__;

const HELP = `snipcode ${VERSION} — deterministic eyes and hands for AI agents

${WORKFLOW}

Commands:
  candidates <url>                        inventory a page's targetable elements
  extract <url> --selector "<css>"        snip one element to clean, self-contained code
  schema <url>                            read a whole-page design reference

Options:
  --selector "<css>"     (extract) the element to snip
  --format <fmt>         (extract, schema) one of: ${FORMAT_NAMES.join(', ')}  [default html]
  --out <dir>            output directory for files  [default ./snipcode-out]
  --expect-text "<t>"    (extract) recorded candidate text, for drift verification
  --expect-rect "<json>" (extract) recorded candidate rect {x,y,w,h}, for drift verification
  --headed               run the browser headed (debugging)
  --help, --version

Guidance:
${CANDIDATES}

${EXTRACT}

${SCHEMA}

${NAMING}

${REDESIGN}
`;

/** Parse argv (after the command + url) into the flag bag. Value flags consume the next token. */
function parseFlags(rest: string[]): Partial<Args> {
	const args: Partial<Args> = {};
	for (let i = 0; i < rest.length; i++) {
		const flag = rest[i];
		const value = rest[i + 1];
		switch (flag) {
			case '--selector': if (value !== undefined) { args.selector = value; i++; } break;
			case '--format': if (value !== undefined) { args.format = value; i++; } break;
			case '--out': if (value !== undefined) { args.out = value; i++; } break;
			case '--expect-text': if (value !== undefined) { args.expectText = value; i++; } break;
			case '--expect-rect': if (value !== undefined) { args.expectRect = value; i++; } break;
			case '--headed': args.headed = true; break;
			default:
				// Unknown flags are ignored so future flags do not hard-fail an older cli.
				break;
		}
	}
	return args;
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
	const url = argv[1];
	if (!url || url.startsWith('--')) {
		emitError('MISSING_URL', `${command} requires a <url> as its first argument`);
		return;
	}
	const args: Args = { url, ...parseFlags(argv.slice(2)) };

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
