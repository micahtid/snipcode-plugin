/**
 * cli/src/commands.ts: the three command implementations.
 *
 * Each loads the page through the runner, drives one core command, writes the file
 * side effects under --out, and emits one JSON payload (or a JSON error). All the
 * page-loading and injection lives in the runner; all the agent guidance lives in
 * instructions/. These functions are the thin seam that wires them to stdout.
 */
import { withPage, PageBlockedError, type ExtractOutcome } from '../../runner/src/browser';
import { emit, emitError, ensureOutDir, writeOut, dataUrlToBuffer, normalizeFormat } from './output';
import { renderSchemaMd, type SchemaStamp } from './schema-md';
import { INLINE } from '../../instructions/guidance';
import type { SchemaResult } from '../../core/src/schema';

/** Parsed command-line arguments, already split from argv. */
export interface Args {
	url: string;
	selector?: string;
	format?: string;
	out?: string;
	expectText?: string;
	expectRect?: string;
	headed?: boolean;
}

/** One split-out asset file the pipeline lifted from the artifact. */
interface AssetFile {
	name: string;
	language: 'html' | 'svg' | 'image' | 'json' | 'font';
	text?: string;
	dataUrl?: string;
}

/** candidates: inventory the page and save a full-page screenshot. */
export async function runCandidates(args: Args): Promise<void> {
	const outDir = ensureOutDir(args.out);
	try {
		await withPage(args.url, { headless: !args.headed }, async (driver) => {
			const inventory = (await driver.candidates()) as Record<string, unknown>;
			const shot = await driver.fullScreenshot();
			const shotPath = writeOut(outDir, 'candidates.png', shot);
			emit({ url: args.url, screenshot: shotPath, ...inventory, guidance: INLINE.candidates });
		});
	} catch (err) {
		reportError(err, outDir);
	}
}

/** extract: snip one element to a self-contained artifact, or hand back a builder crop. */
export async function runExtract(args: Args): Promise<void> {
	if (!args.selector) {
		emitError('MISSING_SELECTOR', 'extract requires --selector "<css>"');
		return;
	}
	let format: string;
	try {
		format = normalizeFormat(args.format);
	} catch (err) {
		emitError('BAD_FORMAT', (err as Error).message);
		return;
	}
	const outDir = ensureOutDir(args.out);
	const expect = buildExpectation(args);

	try {
		await withPage(args.url, { headless: !args.headed }, async (driver) => {
			const result: ExtractOutcome = await driver.extract(args.selector!, format, expect);
			if (!result.ok) {
				emitError(result.error?.code ?? 'EXTRACT_FAILED', result.error?.message ?? 'extract failed', {
					selector: result.selector,
					...(result.error?.actual ? { actual: result.error.actual } : {}),
				});
				return;
			}
			if (result.builderDetected) {
				const crop = await driver.elementScreenshot(args.selector!);
				const cropPath = crop ? writeOut(outDir, 'element.png', crop) : null;
				emit({
					url: args.url,
					selector: result.selector,
					builderDetected: true,
					builder: result.builder ?? null,
					elementScreenshot: cropPath,
					warnings: result.warnings ?? [],
					guidance: INLINE.extract,
				});
				return;
			}
			// The self-contained artifact is output.html; also write the pipeline's lifted
			// asset files (svgs, images, fonts) so the agent can use the split form. Skip the
			// split index.html: output.html already carries the markup, inlined.
			const artifactPath = writeOut(outDir, 'output.html', result.output ?? '');
			const files = (result.files as AssetFile[] | undefined) ?? [];
			const assetPaths: string[] = [];
			for (const f of files) {
				if (f.name === 'index.html') continue;
				const data = f.text !== undefined ? f.text : f.dataUrl ? dataUrlToBuffer(f.dataUrl) : null;
				if (data == null) continue;
				assetPaths.push(writeOut(outDir, f.name, data));
			}
			emit({
				url: args.url,
				selector: result.selector,
				format,
				builderDetected: false,
				artifact: artifactPath,
				assets: assetPaths,
				html: result.html,
				css: result.css,
				warnings: result.warnings ?? [],
				guidance: INLINE.extract,
			});
		});
	} catch (err) {
		reportError(err, outDir);
	}
}

/** schema: whole-page design reference. */
export async function runSchema(args: Args): Promise<void> {
	const outDir = ensureOutDir(args.out);
	try {
		await withPage(args.url, { headless: !args.headed }, async (driver) => {
			const result = (await driver.schema()) as SchemaResult;
			// Stamp every schema output with the version and time it was generated, so an agent
			// can tell a fresh run from a stale file an older version left on disk.
			const stamp: SchemaStamp = { by: 'snipcode', version: __SNIPCODE_VERSION__, at: new Date().toISOString() };
			// The schema command no longer writes a full-page screenshot: the tokens and layout
			// blueprint are the whole reference, and the extension proved the first-generation
			// schema needs no visual iteration. Re-enable by uncommenting these two lines and the
			// `screenshot` field below if a visual reference is wanted again.
			// const shot = await driver.fullScreenshot();
			// const shotPath = writeOut(outDir, 'screenshot.png', shot);
			const jsonPath = writeOut(outDir, 'schema.json', JSON.stringify({ generated: stamp, ...result.schema }, null, 2));
			const mdPath = writeOut(outDir, 'schema.md', renderSchemaMd(result, stamp));
			emit({
				url: args.url,
				generated: stamp,
				schema: jsonPath,
				markdown: mdPath,
				// screenshot: shotPath,
				// Echo every measured block, not just tokens and sections: an agent that reads
				// the payload instead of the files should see the same schema the files carry.
				tokens: result.schema.tokens,
				sections: result.schema.sections,
				contentPatterns: result.schema.contentPatterns,
				buttons: result.schema.buttons,
				cards: result.schema.cards,
				nav: result.schema.nav,
				decorative: result.schema.decorative,
				responsive: result.schema.responsive,
				guidance: INLINE.schema,
			});
		});
	} catch (err) {
		reportError(err, outDir);
	}
}

/** Build the drift-verification expectation from --expect-text / --expect-rect, when given. */
function buildExpectation(args: Args): { text?: string; rect?: { x: number; y: number; w: number; h: number } } | undefined {
	const expect: { text?: string; rect?: { x: number; y: number; w: number; h: number } } = {};
	if (args.expectText) expect.text = args.expectText;
	if (args.expectRect) {
		try {
			const rect = JSON.parse(args.expectRect) as { x: number; y: number; w: number; h: number };
			if (['x', 'y', 'w', 'h'].every((k) => typeof (rect as Record<string, unknown>)[k] === 'number')) expect.rect = rect;
		} catch {
			// A malformed --expect-rect is ignored rather than failing the snip; text still verifies.
		}
	}
	return expect.text || expect.rect ? expect : undefined;
}

/** Map an error to the JSON error contract, saving a screenshot for the blocked case. */
function reportError(err: unknown, outDir: string): void {
	if (err instanceof PageBlockedError) {
		const path = err.screenshot.byteLength ? writeOut(outDir, 'blocked.png', err.screenshot) : null;
		emitError('BLOCKED', err.message, path ? { screenshot: path } : undefined);
		return;
	}
	emitError('RUNNER_ERROR', (err as Error).message);
}
