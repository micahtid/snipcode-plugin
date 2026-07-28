/**
 * test/run.ts: end-to-end tests for the snipcode cli.
 *
 * Serves the fixtures over http, then drives the *built* cli as a subprocess for every
 * scenario and asserts against the JSON it prints and the files it writes. This is the
 * real integration surface an agent shells out to, so the tests exercise it exactly as
 * an agent would: argv in, one JSON object out, side-effect files under --out.
 *
 * Run with: npm test (builds first). Requires `npx playwright install chromium`.
 */
import { rm } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import * as GUIDANCE from '../instructions/guidance';
import { composeSkills } from '../cli/src/gen-skill';
import { Checks, CLI, HERE, ROOT, runCli, startServer, startCrossOriginServer, type CliResult } from './harness';

const OUT_BASE = join(HERE, '.out');

const checks = new Checks();
const check = checks.check.bind(checks);

/** Every exported guidance block, flattened, so a rule can be asserted wherever it lives. */
function guidanceBlocks(): [name: string, text: string][] {
	const out: [string, string][] = [];
	for (const [name, value] of Object.entries(GUIDANCE)) {
		if (typeof value === 'string') out.push([name, value]);
		else if (value && typeof value === 'object') {
			for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
				if (typeof text === 'string') out.push([`${name}.${key}`, text]);
			}
		}
	}
	return out;
}

/** Every source file under a directory, recursively. */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
		else out.push(path);
	}
	return out;
}

/**
 * The guidance surface, asserted directly rather than through a run.
 *
 * The rule this plan strengthened was already written down and was still ignored, and the
 * guidance had no tests at all, so the parts that can be held down mechanically are. Each check
 * keys on a short phrase, not a whole sentence, so rewording survives and dropping a rule does
 * not. A failure here is a decision to make, never a string to silence.
 */
function checkGuidance(): void {
	process.stdout.write('\nguidance:\n');
	// Matched against one line, so a phrase that happens to wrap still reads as itself and
	// rewrapping a paragraph is never a failure.
	const REDESIGN = GUIDANCE.REDESIGN.replace(/\s+/g, ' ');
	const INLINE = GUIDANCE.INLINE;

	check('REDESIGN states the element list is closed', /element list is complete/.test(REDESIGN));
	check('REDESIGN says an unlisted element does not exist in that section', /does not exist in that section/.test(REDESIGN));
	check('REDESIGN argues an invented element has no spec to be built from',
		/no spec for it/.test(REDESIGN) && /guess/.test(REDESIGN));
	check('REDESIGN keeps the label-above-a-heading illustration', /label above a heading/.test(REDESIGN));
	check('REDESIGN states what is hard in every use', /Hard in every use/.test(REDESIGN));
	check('REDESIGN scopes the page-level arrangement to a reference rebuild',
		/page-level arrangement/.test(REDESIGN) && /rebuilding the reference page/.test(REDESIGN));
	check("REDESIGN defers to the user's own structure", /arrangement is theirs/.test(REDESIGN));
	check('REDESIGN states the reference-rebuild default', /That is the default/.test(REDESIGN));
	check('REDESIGN binds an effect to the section it was measured in', /Use it in that section and nowhere else/.test(REDESIGN));
	check('INLINE.schema carries the two-level form',
		/hard contract/.test(INLINE.schema) && /only when rebuilding the reference page/.test(INLINE.schema));

	// A thing the schema names but never specifies has to be left out, or the agent styles it
	// from guesswork. Silence is the other case, and rules 5 and 6 still fill that by judgment.
	const RULES = GUIDANCE.RULES.replace(/\s+/g, ' ');
	check('RULES refuses to build what the schema does not specify', /Build only what the schema specifies/.test(RULES));
	check('RULES names the unspecified effect as the case', /never specifies is one you do not paint/.test(RULES));
	check('RULES keeps silence separate from an unspecified value', /This is not the same as silence/.test(RULES));
	check('RULES does not license mixing a shade off the palette', !/one visible step lighter or darker/.test(RULES));

	const dashed = guidanceBlocks().filter(([, text]) => text.includes('—'));
	check('no guidance block carries an em dash', dashed.length === 0, dashed.map(([n]) => n).join(', '));

	// Editing guidance and forgetting to regenerate ships stale rules to every agent that reads
	// the skill. The text is composed in memory from the same source the generator uses, since
	// shelling out to gen:skill would rewrite tracked files as a side effect of running tests.
	const stale = composeSkills().filter(({ path, text }) => {
		if (!existsSync(path)) return true;
		// Line endings are the checkout's business, not the guidance's.
		return readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== text.replace(/\r\n/g, '\n');
	});
	check('the committed SKILL.md files match the current guidance', stale.length === 0,
		`${stale.map((s) => s.path).join(', ')}: run npm run gen:skill`);

	// The comment standard the cleaning pass set, held after the pass that set it.
	const commented = [...sourceFiles(join(ROOT, 'core', 'src', 'inspect', 'schema')), join(ROOT, 'cli', 'src', 'schema-md.ts')];
	const withDashes = commented.filter((path) => readFileSync(path, 'utf8').includes('—'));
	check('no schema module carries an em dash', withDashes.length === 0, withDashes.join(', '));
}

/** Where the module graph starts: the two bundles, the generator, and the test scripts. */
const ENTRY_POINTS = [
	'core/src/entry.ts',
	'cli/src/index.ts',
	'cli/src/gen-skill.ts',
	'test/run.ts',
	'test/golden.ts',
	'test/fidelity.ts',
	'test/parity.ts',
];

/** Directories whose every module has to be reachable from an entry point. */
const SHIPPED_DIRS = ['core/src', 'cli/src', 'runner/src', 'instructions'];

/**
 * Modules that are known to be unreachable and are tolerated for now.
 *
 * Empty is the goal. An entry here is a file that ships in the repo and that nothing can
 * load, which is the state this list exists to drain.
 */
const UNREACHABLE_ALLOWED: string[] = [
	'core/src/convert/vault.ts',
	'core/src/inspect/assets.ts',
	'core/src/inspect/colors.ts',
	'core/src/inspect/fonts.ts',
	'core/src/inspect/types.ts',
	'core/src/reconcile/probe-fonts.ts',
	'core/src/reconcile/probe.ts',
	'core/src/utils/url.ts',
];

/** Every relative module specifier in a source file, static and dynamic. */
function importsOf(text: string): string[] {
	const out: string[] = [];
	const patterns = [
		/\bfrom\s*['"]([^'"]+)['"]/g,
		/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
		/\bimport\s+['"]([^'"]+)['"]/g,
		/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
	];
	for (const re of patterns) {
		for (const m of text.matchAll(re)) if (m[1]!.startsWith('.')) out.push(m[1]!);
	}
	return out;
}

/** Resolve a relative specifier to a file on disk the way the bundler and tsx both would. */
function resolveImport(fromFile: string, spec: string): string | null {
	const base = join(dirname(fromFile), spec);
	const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), base.replace(/\.js$/, '.ts')];
	for (const path of candidates) {
		if (existsSync(path) && statSync(path).isFile()) return path;
	}
	return null;
}

/**
 * Walk the module graph from every entry point and report shipped modules it never reaches.
 *
 * A file no entry point can load is dead weight that still has to be read, typechecked, and
 * kept in step with the rest. Declaration files are skipped: they are ambient by design.
 */
function checkReachability(): void {
	process.stdout.write('\nreachability:\n');
	const seen = new Set<string>();
	const queue = ENTRY_POINTS.map((p) => join(ROOT, p));
	for (const entry of queue) {
		if (!existsSync(entry)) {
			check(`entry point ${relative(ROOT, entry)} exists`, false);
			return;
		}
	}
	while (queue.length) {
		const file = queue.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		for (const spec of importsOf(readFileSync(file, 'utf8'))) {
			const resolved = resolveImport(file, spec);
			if (resolved && !seen.has(resolved)) queue.push(resolved);
		}
	}

	const shipped: string[] = [];
	for (const dir of SHIPPED_DIRS) shipped.push(...sourceFiles(join(ROOT, dir)));
	const unreachable = shipped
		.filter((p) => p.endsWith('.ts') && !p.endsWith('.d.ts') && !seen.has(p))
		.map((p) => relative(ROOT, p).replace(/\\/g, '/'))
		.sort();

	const unexpected = unreachable.filter((p) => !UNREACHABLE_ALLOWED.includes(p));
	check('every shipped module is reachable from an entry point', unexpected.length === 0, unexpected.join(', '));
	const stale = UNREACHABLE_ALLOWED.filter((p) => !unreachable.includes(p));
	check('the unreachable allowance lists nothing already deleted', stale.length === 0, stale.join(', '));
}

async function main(): Promise<void> {
	if (!existsSync(CLI)) {
		process.stdout.write(`cli not built at ${CLI}; run \`npm run build\` first\n`);
		process.exitCode = 1;
		return;
	}
	await rm(OUT_BASE, { recursive: true, force: true });
	checkReachability();
	checkGuidance();
	const { server, base } = await startServer();
	const cdn = await startCrossOriginServer();
	const sample = `${base}/sample.html`;
	const builder = `${base}/builder.html`;
	const framework = `${base}/framework.html?css=${encodeURIComponent(cdn.url)}`;
	const app = `${base}/app.html`;

	try {
		// --- candidates ---
		process.stdout.write('\ncandidates:\n');
		const cand = await runCli(['candidates', sample, '--out', join(OUT_BASE, 'cand')]);
		const candidates = (cand.json.candidates as any[]) ?? [];
		const login = candidates.find((c) => c.role === 'button' && String(c.text ?? '').trim() === 'Log In');
		const landmarks = (cand.json.landmarks as any[]) ?? [];
		check('candidates exits 0', cand.code === 0, `code ${cand.code}`);
		check('candidates returns a non-empty inventory', candidates.length > 0, `${candidates.length} found`);
		check('candidates finds the login button', !!login && login.role === 'button', JSON.stringify(login));
		check('login candidate has a durable selector', !!login && typeof login.selector === 'string' && (login.selector as string).length > 0);
		check('candidates reports landmarks', landmarks.some((l) => l.role === 'banner') && landmarks.some((l) => l.role === 'nav'));
		check('cards are collapsed to one repeat representative', candidates.some((c) => typeof c.repeat === 'number' && (c.repeat as number) >= 3));
		check('candidates screenshot written', typeof cand.json.screenshot === 'string' && existsSync(cand.json.screenshot as string));
		check('candidates carries inline guidance', typeof cand.json.guidance === 'string');

		// --- extract (html, the happy path) ---
		process.stdout.write('\nextract (html):\n');
		const ex = await runCli(['extract', sample, '--selector', '#login', '--out', join(OUT_BASE, 'ex')]);
		const artifact = ex.json.artifact as string | undefined;
		const doc = artifact && existsSync(artifact) ? readFileSync(artifact, 'utf8') : '';
		check('extract exits 0', ex.code === 99, `code ${ex.code}`);
		check('extract did not hit the builder gate', ex.json.builderDetected === false);
		check('extract wrote output.html', !!artifact && existsSync(artifact));
		check('artifact contains the button label', doc.includes('Log In'));
		check('artifact carries the brand color', /#2b6cb0|rgb\(43, ?108, ?176\)/i.test(doc), 'brand color baked');
		check('artifact is self-contained (no http asset refs)', !/https?:\/\//.test(doc.replace(/https?:\/\/(www\.)?w3\.org/g, '')), 'no external urls');

		// --- extract with drift verification ---
		process.stdout.write('\nextract (drift verification):\n');
		const good = await runCli(['extract', sample, '--selector', '#login', '--expect-text', 'Log In', '--out', join(OUT_BASE, 'good')]);
		check('extract with correct --expect-text passes', good.code === 0 && good.json.builderDetected === false);
		const shifted = await runCli(['extract', sample, '--selector', '#login', '--expect-text', 'Totally Different Zzz', '--out', join(OUT_BASE, 'shift')]);
		check('extract with wrong --expect-text fails PAGE_SHIFTED', shifted.code === 1 && (shifted.json.error?.code) === 'PAGE_SHIFTED', shifted.raw.slice(0, 120));

		// --- extract error contract ---
		process.stdout.write('\nextract (errors):\n');
		const noMatch = await runCli(['extract', sample, '--selector', '#nope', '--out', join(OUT_BASE, 'nomatch')]);
		check('unknown selector fails SELECTOR_NO_MATCH', noMatch.code === 1 && (noMatch.json.error?.code) === 'SELECTOR_NO_MATCH');
		const badFmt = await runCli(['extract', sample, '--selector', '#login', '--format', 'crayon', '--out', join(OUT_BASE, 'badfmt')]);
		check('unknown format fails BAD_FORMAT', badFmt.code === 1 && (badFmt.json.error?.code) === 'BAD_FORMAT');

		// --- extract other formats ---
		// Each format is asserted on its content, not just its exit code. The three shapes
		// differ: tailwind moves the styling into the class attribute, jsx wraps the markup in
		// a component, vue emits a single-file component. An empty artifact exits zero too.
		process.stdout.write('\nextract (formats):\n');
		const formats: Record<string, CliResult> = {};
		for (const fmt of ['tailwind', 'jsx', 'vue']) {
			const r = await runCli(['extract', sample, '--selector', '#login', '--format', fmt, '--out', join(OUT_BASE, `fmt-${fmt}`)]);
			formats[fmt] = r;
			check(`extract --format ${fmt} succeeds`, r.code === 0 && r.json.builderDetected === false, r.raw.slice(0, 120));
		}

		const tw = String(formats['tailwind']?.json.html ?? '');
		const twCss = String(formats['tailwind']?.json.css ?? '');
		check('tailwind carries the button label', tw.includes('Log In'), tw.slice(0, 80));
		check('tailwind moves the styling into utility classes',
			/class="[^"]*bg-\[#2b6cb0\]/.test(tw) && /\bpt-\[[\d.]+rem\]/.test(tw) && tw.includes('font-semibold'), tw.slice(0, 200));
		check('tailwind writes no style block into the markup', !/<style/.test(tw), tw.slice(0, 200));
		// Whatever css survives a tailwind snip is a synthesized override for a state the class
		// attribute cannot express, so every declaration in it carries !important. A plain
		// declaration here means base styling leaked back out of the utility classes.
		const twDecls = twCss.split('\n').filter((l) => /^\s*[a-z-]+\s*:/.test(l));
		check('tailwind leaves only synthesized state rules in css',
			twDecls.length > 0 && twDecls.every((l) => l.includes('!important')), twCss.slice(0, 200));

		const jsx = String(formats['jsx']?.json.html ?? '');
		check('jsx is a component that returns its markup',
			/export default function \w+\(\)/.test(jsx) && jsx.includes('return ('), jsx.slice(0, 120));
		check('jsx uses className and never class', jsx.includes('className=') && !/\sclass=/.test(jsx), jsx.slice(0, 200));
		check('jsx carries the button label', jsx.includes('Log In'));
		check('jsx closes every tag it opens', (jsx.match(/<button/g) ?? []).length === (jsx.match(/<\/button>/g) ?? []).length);

		const vue = String(formats['vue']?.json.html ?? '');
		check('vue emits a single-file component',
			vue.includes('<template>') && vue.includes('</template>') && vue.includes('<style scoped>'), vue.slice(0, 120));
		check('vue scopes the styling it wrote', /<style scoped>[\s\S]*background-color/.test(vue), vue.slice(0, 200));
		check('vue carries the button label', vue.includes('Log In'));

		// --- builder gate ---
		process.stdout.write('\nbuilder gate:\n');
		const built = await runCli(['extract', builder, '--selector', '#hero', '--out', join(OUT_BASE, 'builder')]);
		check('builder page is detected, not snipped', built.code === 0 && built.json.builderDetected === true, built.raw.slice(0, 160));
		check('builder is named framer', built.json.builder === 'framer', String(built.json.builder));
		check('builder crop screenshot written', typeof built.json.elementScreenshot === 'string' && existsSync(built.json.elementScreenshot as string));

		// --- schema ---
		process.stdout.write('\nschema:\n');
		const sc = await runCli(['schema', sample, '--out', join(OUT_BASE, 'schema')]);
		const tokens = sc.json.tokens as { colors?: unknown[]; fonts?: unknown[] } | undefined;
		check('schema exits 0', sc.code === 0, sc.raw.slice(0, 160));
		check('schema.json written', typeof sc.json.schema === 'string' && existsSync(sc.json.schema as string));
		check('schema.md written', typeof sc.json.markdown === 'string' && existsSync(sc.json.markdown as string));
		check('schema writes no screenshot', sc.json.screenshot === undefined);
		check('schema has color tokens', !!tokens?.colors && tokens.colors.length > 0);
		check('schema has a section blueprint', Array.isArray(sc.json.sections) && (sc.json.sections as unknown[]).length > 0);
		check('schema has no voice samples', sc.json.voice === undefined);
		const generated = sc.json.generated as { by?: string; version?: string; at?: string } | undefined;
		check('schema output is stamped', generated?.by === 'snipcode' && !!generated.version && !!generated.at);
		const md = typeof sc.json.markdown === 'string' ? readFileSync(sc.json.markdown, 'utf8') : '';
		check('schema.md renders tokens + layout', md.includes('## Tokens') && md.includes('## Layout'));
		check('schema.md carries the stamp', md.includes('Generated by snipcode'));

		// --- schema on a framework-shaped page ---
		// Everything below runs against framework.html: an app root, single-child wrapper
		// chains, hashed structural class names, a preflight border-color reset, a gradient
		// hero, and hairline borders. That shape is what defeated the style-reading extractor,
		// so each check pins one measurement that used to come back wrong.
		process.stdout.write('\nschema (framework page):\n');
		const fw = await runCli(['schema', framework, '--out', join(OUT_BASE, 'framework')]);
		check('framework schema exits 0', fw.code === 0, fw.raw.slice(0, 200));
		const fwSchema = JSON.parse(readFileSync(fw.json.schema as string, 'utf8'));
		const fwMd = readFileSync(fw.json.markdown as string, 'utf8');
		const fwSections = (fwSchema.sections as any[]) ?? [];
		const findSection = (pred: (s: any) => boolean) => fwSections.find(pred);

		// Section discovery reaches through the app root instead of reporting the page as one section.
		check('sections are found under the app root', fwSections.length >= 5, `${fwSections.length} sections`);

		const header = findSection((s) => s.tag === 'header');
		check('the header classifies as nav, not cta', header?.type === 'nav', String(header?.type));

		const heroSection = findSection((s) => s.elements?.includes('heading') && s.elements?.includes('button-pair'));
		check('the hero catalogs a non-empty element list', !!heroSection && heroSection.elements.length > 0, JSON.stringify(heroSection?.elements));
		check('the centered hero reports center alignment', heroSection?.alignment === 'center', String(heroSection?.alignment));
		check('the hero reports a measured stack, not a default', heroSection?.layoutMeasured === true && heroSection?.layout === 'centered-stack', String(heroSection?.layout));

		const twoCol = findSection((s) => s.gridColumns === 2);
		check('the two-column section reports two columns', !!twoCol, JSON.stringify(fwSections.map((s) => [s.type, s.layout, s.gridColumns])));
		check('the two-column section reports a width ratio', typeof twoCol?.columnRatio === 'string' && /^\d+\/\d+$/.test(twoCol.columnRatio), String(twoCol?.columnRatio));

		const grid3 = findSection((s) => s.gridColumns === 3 && s.layout === 'grid-3' && s.tag === 'section');
		check('the card grid reports three columns', !!grid3, JSON.stringify(fwSections.map((s) => [s.tag, s.layout, s.gridColumns])));

		const unmeasured = fwSections.filter((s) => s.layoutMeasured === false);
		check('a section that defeats measurement reports unknown', unmeasured.length === 1 && unmeasured[0].layout === 'unknown', JSON.stringify(unmeasured));
		check('schema.md prints an unmeasured layout as unknown', fwMd.includes('unknown (not measured)'));

		// Colors: weighted contexts, per-side borders, gradients, and alpha survival.
		const fwColors = (fwSchema.tokens?.colors as any[]) ?? [];
		const ink = fwColors.find((c) => c.value === '#2d2d2d');
		check('the text ink is in the palette', !!ink, JSON.stringify(fwColors.slice(0, 6)));
		check('the text ink does not list border as a context', !!ink && !ink.contexts.includes('border'), JSON.stringify(ink));
		check('the text ink is reported as text', ink?.contexts[0] === 'text', JSON.stringify(ink?.contexts));
		check('the gradient accent reaches the palette', fwColors.some((c) => c.value === '#ff6b4a'), JSON.stringify(fwColors.map((c) => c.value)));
		check('the hairline border survives in alpha form', fwColors.some((c) => /^rgba\(/.test(c.value) && c.contexts.includes('border')), JSON.stringify(fwColors.map((c) => c.value)));
		const multiValued = fwColors.filter((c) => (String(c.value).match(/rgba?\(|#[0-9a-f]{3,8}\b/gi) ?? []).length > 1);
		check('no palette entry carries two color values', multiValued.length === 0, JSON.stringify(multiValued));

		// Components: sane buttons, the header bar as the nav, breakpoints from the media queries.
		const fwButtons = (fwSchema.buttons as any[]) ?? [];
		check('button blueprints are extracted', fwButtons.length > 0);
		check('every button blueprint has non-zero padding', fwButtons.every((b) => /(^|\s)(?!0px)[\d.]+px/.test(b.padding)), JSON.stringify(fwButtons.map((b) => b.padding)));
		check('the primary button is the coral one', fwButtons[0]?.bg === '#ff6b4a', JSON.stringify(fwButtons[0]));
		check('a shadow of transparent layers is not reported as elevation', fwButtons[0]?.shadow === '' && fwButtons[0]?.styleTag === 'flat', JSON.stringify([fwButtons[0]?.shadow, fwButtons[0]?.styleTag]));

		const fwNav = fwSchema.nav;
		check('the nav blueprint is the header bar, not an inner nav', fwNav?.tag === 'header', JSON.stringify(fwNav));

		const fwCards = (fwSchema.cards as any[]) ?? [];
		check('card blueprints are extracted', fwCards.length > 0);
		check('card inner layout reads through the wrappers', fwCards[0]?.innerLayout?.includes('heading'), String(fwCards[0]?.innerLayout));
		check('a card shadow keeps its painting layer and drops the rest', fwCards[0]?.shadow?.includes('0.06') && !fwCards[0].shadow.includes('rgba(0, 0, 0, 0)'), String(fwCards[0]?.shadow));

		const marquee = findSection((s) => s.layout === 'horizontal-scroll');
		check('a track wider than its section reads as horizontal scroll, not columns', !!marquee, JSON.stringify(fwSections.map((s) => [s.layout, s.gridColumns])));

		// --- section types read off the measurements, not off class names or section text ---
		process.stdout.write('\nschema (types from measurements):\n');
		const cardGrid = grid3;
		check('the gradient hero types as hero', heroSection?.type === 'hero', String(heroSection?.type));
		check('the icon+heading+text card grid types as features', cardGrid?.type === 'features', String(cardGrid?.type));
		check('the two-column section does not type as logos', twoCol?.type !== 'logos', String(twoCol?.type));
		check('the logo marquee types as logos', marquee?.type === 'logos', String(marquee?.type));
		check('a section nothing classifies reports content', fwSections.some((s) => s.type === 'content'), JSON.stringify(fwSections.map((s) => s.type)));

		// --- repetition described by its numbers ---
		process.stdout.write('\nschema (repetition):\n');
		check('the marquee counts every logo on its track', marquee?.items?.count === 15, JSON.stringify(marquee?.items));
		check("the marquee reports one item's size", marquee?.items?.width === 120 && marquee?.items?.height === 36, JSON.stringify(marquee?.items));
		check("the marquee reports one item's make-up", marquee?.items?.shape?.join('+') === 'image', JSON.stringify(marquee?.items?.shape));
		const looped = fwSections.filter((s) => s.layout === 'horizontal-scroll')[1];
		check('a duplicated marquee track reports its distinct run', looped?.items?.count === 6, JSON.stringify(looped?.items));
		check('the card grid reports its three items', cardGrid?.items?.count === 3 && cardGrid.items.shape.includes('icon'), JSON.stringify(cardGrid?.items));
		check('schema.md renders the items line', /- items: 15 × ~120x36 \(image\)/.test(fwMd), fwMd.split('\n').filter((l) => l.includes('items:')).join(' | '));

		// --- visual evidence before tag defaults, and one gate for every token ---
		check('an article-tagged card still produces a card blueprint', fwCards.length > 0 && fwCards[0]?.borderRadius === '14px', JSON.stringify(fwCards.map((c) => c.borderRadius)));
		// One variant, the three articles. A section reading as a card after the reorder would
		// show up here as a second one, which is the reorder's only real risk.
		check('no page section leaked into the card blueprints', fwCards.length === 1, JSON.stringify(fwCards.map((c) => [c.bg, c.borderRadius, c.padding])));
		const fwRadii = (fwSchema.tokens?.radii as string[]) ?? [];
		check('no radius token carries more than one value', fwRadii.length > 0 && fwRadii.every((r) => !/\s/.test(r)), JSON.stringify(fwRadii));
		const fwSpacing = (fwSchema.tokens?.spacing as string[]) ?? [];
		check('no spacing token carries more than one value', fwSpacing.every((v) => !/\s/.test(v)), JSON.stringify(fwSpacing));

		// A nav hidden by utility classes is a hamburger. No rule on this page mentions "nav".
		check('a utility-hidden nav link reads as a hamburger', fwSchema.responsive?.mobileNavStyle === 'hamburger', JSON.stringify(fwSchema.responsive));

		// Rules the old top-level, same-origin, unescaped read could not see at all.
		const breakpoints = (fwSchema.responsive?.breakpoints as string[]) ?? [];
		check('breakpoints are non-empty when the page declares media queries', breakpoints.length >= 2, JSON.stringify(breakpoints));
		check('a range-notation breakpoint inside @layer is read', breakpoints.includes('48rem'), JSON.stringify(breakpoints));
		check('a cross-origin stylesheet is recovered through the host', breakpoints.includes('1280px'), JSON.stringify(breakpoints));
		const fwStates = (fwSchema.states as any[]) ?? [];
		check('hover rules inside @layer are lifted', fwStates.some((s) => s.state === 'hover'), JSON.stringify(fwStates.map((s) => s.selector)));
		check('an escaped utility-class state selector matches its element', fwStates.some((s) => s.selector.includes('hover\\:underline-x')), JSON.stringify(fwStates.map((s) => s.selector)));

		// --- decorative effects carry the section they were seen in ---
		// An effect stated for the whole page reads as permission to paint it anywhere, which is
		// how a rebuild put a gradient into a hero the schema measured as flat. Every effect
		// names a section, and one the schema cannot place is never shown.
		process.stdout.write('\nschema (located effects):\n');
		const fwEffects = (fwSchema.decorative?.backgroundEffects as any[]) ?? [];
		const fwDecorLine = fwMd.split('\n').find((l: string) => l.startsWith('**Decorative**')) ?? '';
		const heroIndex = fwSections.indexOf(heroSection);
		check('the gradient hero yields an effect located at the hero section',
			fwEffects.some((e) => e.effect === 'gradient' && e.section === heroIndex), JSON.stringify(fwEffects));
		check('schema.md names the section an effect was seen in', fwDecorLine.includes('gradient (hero)'), fwDecorLine);
		check('an effect in one of two same-typed sections carries its position', fwDecorLine.includes('gradient (logos 2)'), fwDecorLine);
		// A gradient declared on a zero-size node paints nothing, so it is not an effect.
		const emptyIndex = fwSections.findIndex((s) => s.layoutMeasured === false);
		check('an effect declared on a node with no box is not reported',
			emptyIndex >= 0 && !fwEffects.some((e) => e.section === emptyIndex), JSON.stringify([emptyIndex, fwEffects]));
		// The blob is out of flow on the page wrapper, so no section holds it.
		const unplaced = fwEffects.filter((e) => e.section === undefined);
		check('an effect no section holds is recorded without a location',
			unplaced.length === 1 && unplaced[0].effect === 'blur-blobs', JSON.stringify(fwEffects));
		check('an unlocated effect never reaches schema.md', !fwDecorLine.includes('blur-blobs'), fwDecorLine);
		check('schema.md prints no bare blobs assertion', !/\bblobs\b/.test(fwMd) && fwSchema.decorative?.hasBlobs === true, fwDecorLine);
		// Fields measured and never delivered are gone rather than left in the payload unread.
		check('the decorative payload carries no undelivered field',
			Object.keys(fwSchema.decorative ?? {}).join(',') === 'hasBlobs,illustrationStyle,backgroundEffects,accentTreatments',
			JSON.stringify(Object.keys(fwSchema.decorative ?? {})));

		// Delivery: the blueprints reach schema.md and the cli payload, not just schema.json.
		check('schema.md renders the components section', fwMd.includes('## Components'));
		check('schema.md renders the nav line', /\*\*Nav\*\* \(header\)/.test(fwMd), fwMd.slice(fwMd.indexOf('## Components'), fwMd.indexOf('## Components') + 200));
		check('schema.md renders the button lines', fwMd.includes('**Buttons**') && fwMd.includes('#ff6b4a'));
		check('schema.md renders the card lines', fwMd.includes('**Cards**') && fwMd.includes('inner:'));
		check('schema.md renders each section background', fwSections.every((s) => fwMd.includes(`bg ${s.background}`)));
		check('schema.md renders the breakpoints', fwMd.includes('**Breakpoints**'));
		check('the cli payload echoes the blueprints', Array.isArray(fw.json.buttons) && Array.isArray(fw.json.cards) && !!fw.json.nav && !!fw.json.responsive);

		// --- schema on an app-root page with a compact type scale ---
		// app.html covers what framework.html cannot: a thirteen-pixel base, a nav with no
		// landmark tag, stats in two scripts, scroll-reveal content, radii a browser serializes
		// strangely, a section long enough to exhaust the walk, and no media queries at all.
		process.stdout.write('\nschema (app-root page):\n');
		const ap = await runCli(['schema', app, '--out', join(OUT_BASE, 'app')]);
		check('app schema exits 0', ap.code === 0, ap.raw.slice(0, 200));
		const apSchema = JSON.parse(readFileSync(ap.json.schema as string, 'utf8'));
		const apSections = (apSchema.sections as any[]) ?? [];
		const apTypes = apSections.map((s) => s.type);

		check('a div-only bar is still found as the nav', apSchema.nav?.tag === 'div' && apSchema.nav.position === 'sticky', JSON.stringify(apSchema.nav));
		check('the div bar types as nav', apTypes[0] === 'nav', JSON.stringify(apTypes));
		const apHero = apSections.find((s) => s.type === 'hero');
		check('a button-less hero on a compact scale still types as hero', !!apHero, JSON.stringify(apTypes));
		check('a 26px heading on a 13px base catalogs as a heading', !!apHero && apHero.elements.includes('heading'), JSON.stringify(apHero?.elements));
		check('the hero has no button to have been classified by', !!apHero && !apHero.elements.some((e: string) => e.startsWith('button')), JSON.stringify(apHero?.elements));
		const apStats = apSections.filter((s) => s.type === 'stats');
		check('a number-led row types as stats', apStats.length === 2, JSON.stringify(apTypes));
		check('a hero whose copy is full of numbers does not type as stats', apHero?.type === 'hero', JSON.stringify(apTypes));
		check('a stats row in non-Latin numerals types the same way', apStats.length === 2 && apStats[1].items?.count === 3, JSON.stringify(apStats[1]?.items));
		check('a section nothing classifies reports content', apTypes.includes('content'), JSON.stringify(apTypes));
		// A dated archive is number-led text in a column. Without the row it read as a stats band.
		const apArchive = apSections.find((s) => s.tag === 'ul');
		check('a dated list in one column is not a stats band', apArchive?.type === 'content' && apArchive.items?.count === 6, JSON.stringify([apArchive?.type, apArchive?.layout, apArchive?.items?.count]));

		// Scroll-reveal content is walked; an out-of-flow node hidden the same way is not.
		const apColors = (apSchema.tokens?.colors as any[])?.map((c) => c.value) ?? [];
		check('an in-flow opacity-0 element with an opacity transition is walked', apColors.includes('#0b7a5a'), JSON.stringify(apColors));
		check('an absolutely positioned opacity-0 element stays invisible', !apColors.includes('#b3126a'), JSON.stringify(apColors));

		// Per-section budgets, so a two-thousand-element section cannot starve the page's tail.
		const apClosing = apSections[apSections.length - 1];
		check('the last section of a long page still catalogs elements', (apClosing?.elements?.length ?? 0) > 0, JSON.stringify(apClosing?.elements));
		check("the last section's color survives the walk budget", apColors.includes('#7b3fa0'), JSON.stringify(apColors));

		// One gate, so a pill and a corner shorthand both enter as values of their kind.
		const apRadii = (apSchema.tokens?.radii as string[]) ?? [];
		check('a pill radius is normalized, not reported verbatim', apRadii.includes('9999px') && !apRadii.some((r) => parseFloat(r) > 9999), JSON.stringify(apRadii));
		check('a corner shorthand enters as its distinct corner values', apRadii.includes('32px') && apRadii.every((r) => !/\s/.test(r)), JSON.stringify(apRadii));
		check('radii come back sorted ascending', apRadii.every((r, i) => i === 0 || parseFloat(apRadii[i - 1]!) <= parseFloat(r)), JSON.stringify(apRadii));
		// The blueprint is a second path to the same reader, and it used to print the raw number.
		const apButtons = (apSchema.buttons as any[]) ?? [];
		check('a pill radius is gated in the component blueprint too', apButtons.length > 0 && apButtons.every((b) => !/e\+/.test(b.borderRadius)) && apButtons.some((b) => b.borderRadius === '9999px'), JSON.stringify(apButtons.map((b) => b.borderRadius)));

		// The effect reading covers the document, not a spread sample of it. A sample lands on
		// different elements the moment the page's element count moves, so two reads of one page
		// named the gradient in different sections. This one sits past four thousand filler nodes.
		const apMd = readFileSync(ap.json.markdown as string, 'utf8');
		const apEffects = (apSchema.decorative?.backgroundEffects as any[]) ?? [];
		const closingIndex = apSections.length - 1;
		check('an effect four thousand elements deep is still found',
			apEffects.some((e) => e.effect === 'gradient' && e.section === closingIndex), JSON.stringify(apEffects));
		// The page holds several sections of this type, so the name has to carry its position.
		const closingType = apSections[closingIndex]?.type;
		const sameType = apSections.filter((s) => s.type === closingType).length;
		const closingName = sameType > 1 ? `${closingType} ${sameType}` : String(closingType);
		check('schema.md names the deep section the effect sits in',
			apMd.includes(`gradient (${closingName})`),
			apMd.split('\n').find((l: string) => l.startsWith('**Decorative**')) ?? '');

		// No media query says anything, so neither responsive field asserts anything.
		check('a page with no responsive nav evidence reports unknown', apSchema.responsive?.mobileNavStyle === 'unknown', JSON.stringify(apSchema.responsive));
		check('a page with no grid evidence reports unknown', apSchema.responsive?.gridCollapseBehavior === 'unknown', JSON.stringify(apSchema.responsive));

		// --- the same page read twice reads the same ---
		// Ordering and sampling decide what the schema reports. Left unpinned, a later change to
		// either could introduce drift that no single run would ever show.
		process.stdout.write('\nschema (determinism):\n');
		const again = await runCli(['schema', framework, '--out', join(OUT_BASE, 'framework-again')]);
		const stamped = (path: string): string => {
			const parsed = JSON.parse(readFileSync(path, 'utf8'));
			delete parsed.generated; // The stamp is the run's time, and is meant to differ.
			return JSON.stringify(parsed);
		};
		check('two consecutive runs over one page produce identical json',
			again.code === 0 && stamped(again.json.schema as string) === stamped(fw.json.schema as string), again.raw.slice(0, 160));

		// --- a page discovery could not resolve into sections ---
		process.stdout.write('\nschema (unresolved page):\n');
		const one = await runCli(['schema', `${base}/onepage.html`, '--out', join(OUT_BASE, 'onepage')]);
		const oneSchema = JSON.parse(readFileSync(one.json.schema as string, 'utf8'));
		const oneSections = (oneSchema.sections as any[]) ?? [];
		check('a one-box page yields one section', oneSections.length === 1, JSON.stringify(oneSections.map((s) => [s.type, s.tag])));
		check('a section spanning the page reports content, not hero', oneSections[0]?.type === 'content', String(oneSections[0]?.type));
		check('naming cannot rescue an unresolved page', oneSections[0]?.elements?.includes('heading'), JSON.stringify(oneSections[0]?.elements));
	} finally {
		server.close();
		cdn.server.close();
	}

	if (!checks.report()) process.exitCode = 1;
}

main().catch((err) => {
	process.stdout.write(`test harness crashed: ${(err as Error).message}\n`);
	process.exitCode = 1;
});
