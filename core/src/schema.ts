/**
 * core/src/schema.ts: whole-page design reference for redesign prompts.
 *
 * Two layers, both reusing extension machinery so the plugin adds no parallel
 * analysis code. The design tokens and layout map come straight from the page-schema
 * inspector (color palette ranked by usage, font scale, spacing rhythm, radii,
 * shadows, and a section blueprint with grid/flex, column counts, and max-widths).
 * The "voice" layer runs the real extract pipeline on a representative button, card,
 * and nav item, so the agent gets not just what the design tokens are but a concrete,
 * self-contained sample of how the site composes them.
 */
import type { PageSchema } from './inspect/schema/types';
import type { OutputFormat } from './types';
import { extractPageSchema } from './inspect/schema/extract';
import { optimizeSchema } from './inspect/schema/optimize';
import { isElementVisible } from './inspect/schema/classify';
import { extractElement } from './pipeline';

/** One representative component, extracted with the real pipeline. */
export interface VoiceSample {
	/** What the sample stands for: button, card, or nav. */
	role: string;
	/** The selector the sample was taken from. */
	selector: string;
	/** The composed self-contained artifact, or empty when the sample could not be taken. */
	output: string;
	warnings: string[];
}

/** The full schema payload the runner writes to schema.json. */
export interface SchemaResult {
	schema: PageSchema;
	voice: VoiceSample[];
}

/** Shortest-unique-ish selector for a sample element, good enough for the reference. */
function selectorFor(el: Element): string {
	if (el.id) return `#${CSS.escape(el.id)}`;
	const tag = el.tagName.toLowerCase();
	const cls = [...el.classList].slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('');
	return `${tag}${cls}`;
}

/** First visible element matching any selector in the list, or null. */
function firstVisible(selectors: string[]): Element | null {
	for (const selector of selectors) {
		for (const el of document.querySelectorAll(selector)) {
			if (isElementVisible(el)) return el;
		}
	}
	return null;
}

/** The representative button, card, and nav item, whichever the page actually has. */
function representatives(): Array<{ role: string; el: Element }> {
	const out: Array<{ role: string; el: Element }> = [];
	const button = firstVisible(['button', '[role="button"]', 'a.btn', 'a.button', 'a[class*="button"]']);
	if (button) out.push({ role: 'button', el: button });
	const card = firstVisible(['article', '[class*="card"]', 'li[class*="card"]']);
	if (card) out.push({ role: 'card', el: card });
	const navItem = firstVisible(['nav a', 'header nav a', '[role="navigation"] a']);
	if (navItem) out.push({ role: 'nav', el: navItem });
	return out;
}

/**
 * Builds the whole-page schema: design tokens and layout from the inspector, plus a
 * few real component extractions for voice. Async because the voice extractions run
 * the capture pipeline, which reaches the host for its privileged data.
 *
 * @param format - the output format for the voice samples
 */
export async function buildSchema(format: OutputFormat): Promise<SchemaResult> {
	const schema = optimizeSchema(extractPageSchema());

	const voice: VoiceSample[] = [];
	for (const { role, el } of representatives()) {
		const selector = selectorFor(el);
		try {
			const result = await extractElement(el, '', format);
			if (result.builderDetected) {
				voice.push({ role, selector, output: '', warnings: [`builder site (${result.builder ?? 'unknown'}); voice sample skipped`] });
				continue;
			}
			voice.push({ role, selector, output: result.output, warnings: result.warnings });
		} catch (err) {
			voice.push({ role, selector, output: '', warnings: [`voice extraction failed: ${(err as Error).message}`] });
		}
	}

	return { schema, voice };
}
