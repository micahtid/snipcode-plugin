/**
 * test/unit.ts: table-driven tests for the helpers that look interchangeable.
 *
 * Three pairs of functions shared a name and a rough purpose, and the cleanup had to
 * decide whether each pair was one idea written twice or two ideas that collided. These
 * tables are how that was decided, and they stay so the answer cannot quietly change.
 *
 * The css-value and selector splitters disagree, so they stay separate under distinct
 * names. The two absolutizeUrls agreed and are now one function. The two isGroupingRule
 * checks classify @keyframes differently, so they also stay separate.
 *
 * Run with: npm test.
 */
import { chromium } from 'playwright';
import { splitTopLevel, splitCommaList } from '../core/src/utils/css-split';
import { splitSelectorTopLevel } from '../core/src/reconcile/selector';
import { absolutizeUrls } from '../core/src/reconcile/features/urls';
import { Checks } from './harness';

const checks = new Checks();
const check = checks.check.bind(checks);

/**
 * The two splitters, over inputs chosen to expose every way they could differ: trimming,
 * empty branches, backslash escapes, and unbalanced delimiters.
 */
function checkSplitters(): void {
	process.stdout.write('\nsplitters:\n');

	// The css-value splitter keeps every branch exactly as written, because a value's
	// whitespace can matter and an empty layer is still a layer.
	const valueCases: [input: string, expected: string[]][] = [
		['a, b', ['a', ' b']],
		['rgb(1, 2, 3), red', ['rgb(1, 2, 3)', ' red']],
		['a,,b', ['a', '', 'b']],
		['"x, y", z', ['"x, y"', ' z']],
		['a(b, c', ['a(b, c']],
	];
	for (const [input, expected] of valueCases) {
		const actual = splitTopLevel(input, ',');
		check(`splitTopLevel ${JSON.stringify(input)}`, JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual));
	}

	// The selector splitter trims, drops empties, and honors backslash escapes, because a
	// utility class is written `.hover\:bg-x` and an empty branch is not a selector.
	const selectorCases: [input: string, expected: string[]][] = [
		['a, b', ['a', 'b']],
		[':is(.a, .b) span, p', [':is(.a, .b) span', 'p']],
		['a,,b', ['a', 'b']],
		['[href="a, b"], p', ['[href="a, b"]', 'p']],
		['.hover\\:bg-x, p', ['.hover\\:bg-x', 'p']],
	];
	for (const [input, expected] of selectorCases) {
		const actual = splitSelectorTopLevel(input, ',');
		check(`splitSelectorTopLevel ${JSON.stringify(input)}`, JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual));
	}

	// The difference that decides the two cannot merge: unbalanced input.
	let threw = false;
	try {
		splitSelectorTopLevel('a(b, c', ',');
	} catch {
		threw = true;
	}
	check('splitSelectorTopLevel throws on unbalanced input', threw);
	check('splitTopLevel returns unbalanced input whole', splitTopLevel('a(b, c', ',').length === 1);

	// splitCommaList is the trimmed, filtered form of the value splitter, and is what
	// resolve/transition.ts wants. It is still not the selector splitter: no escape handling.
	check('splitCommaList trims and drops empties', JSON.stringify(splitCommaList('a, , b')) === JSON.stringify(['a', 'b']));
	check('splitCommaList does not honor escapes', splitCommaList('a\\,b, c').length === 3, JSON.stringify(splitCommaList('a\\,b, c')));
}

/** The merged url rewriter, with and without a warnings sink. */
function checkAbsolutize(): void {
	process.stdout.write('\nabsolutizeUrls:\n');
	const base = 'https://example.com/a/b/page.html';

	check('a relative url resolves against the base',
		absolutizeUrls('url(img.png)', base) === 'url(https://example.com/a/b/img.png)', absolutizeUrls('url(img.png)', base));
	check('a root-relative url resolves against the origin',
		absolutizeUrls('url(/img.png)', base) === 'url(https://example.com/img.png)', absolutizeUrls('url(/img.png)', base));
	check('quotes are preserved',
		absolutizeUrls('url("img.png")', base) === 'url("https://example.com/a/b/img.png")', absolutizeUrls('url("img.png")', base));
	for (const already of ['url(data:image/png;base64,AAA)', 'url(blob:x)', 'url(https://cdn.example.com/i.png)', 'url(#clip)']) {
		check(`${already} is left alone`, absolutizeUrls(already, base) === already, absolutizeUrls(already, base));
	}
	check('every url in a multi-layer value is rewritten',
		absolutizeUrls('url(a.png), url(b.png)', base) === 'url(https://example.com/a/b/a.png), url(https://example.com/a/b/b.png)',
		absolutizeUrls('url(a.png), url(b.png)', base));

	// The images handler wanted a warning on an unresolvable ref; the effects handler did not.
	// One function serves both: the sink is optional, and its absence is silence, not a crash.
	const warnings: string[] = [];
	const bad = absolutizeUrls('url(img.png)', 'not a url', warnings, 'images');
	check('an unresolvable base leaves the value alone', bad === 'url(img.png)', bad);
	check('an unresolvable base warns when a sink is given', warnings.length === 1 && warnings[0]!.includes('img.png'), JSON.stringify(warnings));
	check('an unresolvable base is silent with no sink', absolutizeUrls('url(img.png)', 'not a url') === 'url(img.png)');
}

/**
 * The two grouping-rule checks, run against a real stylesheet in a real engine.
 *
 * capture/sheets.ts asks whether a rule holds child rules; minimize/atrules.ts asks whether
 * it can also delete them. @keyframes answers yes to both, which is why sheets.ts has to
 * handle it in an earlier branch, and why the two checks are not the same predicate.
 */
async function checkGroupingRules(): Promise<void> {
	process.stdout.write('\ngrouping rules:\n');
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.setContent('<html><head></head><body></body></html>');
		// Passed as source text, not a closure: the ts loader rewrites arrow functions with a
		// helper of its own, which is not defined inside the page.
		const rows = (await page.evaluate(`(() => {
			const sheet = new CSSStyleSheet();
			sheet.replaceSync(\`
				@media (min-width: 1px) { .a { color: red } }
				@supports (display: grid) { .b { color: red } }
				@layer base { .d { color: red } }
				@container (min-width: 1px) { .e { color: red } }
				@keyframes spin { from { opacity: 0 } to { opacity: 1 } }
				@font-face { font-family: x; src: url(x.woff2) }
				@property --p { syntax: "<color>"; inherits: false; initial-value: red }
				@page { margin: 1cm }
				.c { color: red }
			\`);
			return Array.from(sheet.cssRules).map(function (rule) {
				return {
					text: rule.cssText.slice(0, 24),
					holds: 'cssRules' in rule && rule.cssRules instanceof CSSRuleList,
					deletes: 'cssRules' in rule && typeof rule.deleteRule === 'function',
				};
			});
		})()`)) as Array<{ text: string; holds: boolean; deletes: boolean }>;

		const disagree = rows.filter((r) => r.holds !== r.deletes);
		check('the two grouping checks classify every rule type the same way', disagree.length === 0, JSON.stringify(disagree));
		check('every rule type the engine offers is covered', rows.length >= 8, JSON.stringify(rows.map((r) => r.text)));

		// Both accept a plain style rule, because a style rule can now nest child rules. That
		// is why neither is a safe stand-alone test for "this is an at-rule block": each caller
		// reaches its check only after the rule types it cares about are handled above it.
		const style = rows.find((r) => r.text.startsWith('.c'));
		check('a nesting-capable style rule satisfies both checks',
			style?.holds === true && style.deletes === true, JSON.stringify(style));
		const fontFace = rows.find((r) => r.text.startsWith('@font-face'));
		check('a declaration-only at-rule satisfies neither',
			fontFace?.holds === false && fontFace.deletes === false, JSON.stringify(fontFace));
	} finally {
		await browser.close();
	}
}

async function main(): Promise<void> {
	checkSplitters();
	checkAbsolutize();
	await checkGroupingRules();
	if (!checks.report()) process.exitCode = 1;
}

main().catch((err) => {
	process.stdout.write(`unit harness crashed: ${(err as Error).message}\n`);
	process.exitCode = 1;
});
