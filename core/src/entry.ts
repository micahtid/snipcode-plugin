/**
 * core/src/entry.ts: the injectable bundle entry.
 *
 * Bundled to one self-contained iife the runner injects into a Playwright page, hanging the
 * three commands off window.__snipCore. Each returns a plain json-serializable object.
 *
 * extract owns the stateless re-resolution. It re-finds the element by selector in the freshly
 * loaded page and, given the text and rect a candidate recorded, verifies the match first. A
 * shifted page then fails loudly rather than extracting the wrong node.
 */
import type { OutputFormat } from './types';
import { harvestCandidates, normalizedText, rectOf, type CandidateInventory, type CandidateRect } from './candidates';
import { extractElement } from './pipeline';
import { buildSchema, type SchemaResult } from './schema';

/** What the caller recorded about the target at harvest time, for drift detection. */
interface ExtractExpectation {
	text?: string | null;
	rect?: CandidateRect;
}

/** The outcome of one extract call. On failure ok is false and error carries a machine code. */
interface ExtractOutcome {
	ok: boolean;
	error?: { code: string; message: string; actual?: { text: string | null; rect: CandidateRect; matches: number } };
	selector: string;
	/** Document-absolute rect of the resolved element, for the runner's screenshot crop. */
	rect?: CandidateRect;
	builderDetected?: boolean;
	builder?: string | null;
	html?: string;
	css?: string;
	output?: string;
	files?: unknown;
	warnings?: string[];
}

/** Center-distance tolerance (px) and size tolerance (fraction) for the drift check. */
const RECT_SHIFT_PX = 40;
const RECT_SIZE_TOLERANCE = 0.35;

/**
 * Whether the resolved element is close enough to what the candidate recorded. Text compares by
 * prefix, since the recording is capped and exact equality would over-reject. The rect compares
 * by center distance and relative size, tolerating jitter but catching a real shift.
 */
function matchesExpectation(el: Element, expect: ExtractExpectation): boolean {
	if (expect.text) {
		const actual = normalizedText(el);
		const wanted = expect.text.replace(/…$/, '').trim();
		if (wanted && !actual.startsWith(wanted.slice(0, 40))) return false;
	}
	if (expect.rect) {
		const r = rectOf(el);
		const dx = r.x + r.w / 2 - (expect.rect.x + expect.rect.w / 2);
		const dy = r.y + r.h / 2 - (expect.rect.y + expect.rect.h / 2);
		if (Math.hypot(dx, dy) > RECT_SHIFT_PX + Math.max(expect.rect.w, expect.rect.h)) return false;
		const sizeDrift = Math.abs(r.w - expect.rect.w) / Math.max(1, expect.rect.w);
		if (sizeDrift > RECT_SIZE_TOLERANCE && Math.abs(r.w - expect.rect.w) > RECT_SHIFT_PX) return false;
	}
	return true;
}

/** Resolve a selector to one element and snip it, with drift verification when expected data is given. */
async function extract(selector: string, format: OutputFormat, expect?: ExtractExpectation): Promise<ExtractOutcome> {
	let matched: Element[];
	try {
		matched = [...document.querySelectorAll(selector)];
	} catch (err) {
		return { ok: false, selector, error: { code: 'SELECTOR_INVALID', message: `invalid selector: ${(err as Error).message}` } };
	}
	if (matched.length === 0) {
		return { ok: false, selector, error: { code: 'SELECTOR_NO_MATCH', message: `selector matched 0 elements: ${selector}` } };
	}
	const el = matched[0]!;
	const warnings: string[] = [];
	if (matched.length > 1) warnings.push(`selector matched ${matched.length} elements, extracting the first`);

	if (expect && !matchesExpectation(el, expect)) {
		return {
			ok: false,
			selector,
			rect: rectOf(el),
			error: {
				code: 'PAGE_SHIFTED',
				message: 'resolved element does not match the recorded candidate (page shifted); re-run candidates',
				actual: { text: normalizedText(el).slice(0, 80) || null, rect: rectOf(el), matches: matched.length },
			},
		};
	}

	const rect = rectOf(el);
	const result = await extractElement(el, '', format);
	return {
		ok: true,
		selector,
		rect,
		builderDetected: result.builderDetected,
		builder: result.builder,
		html: result.html,
		css: result.css,
		output: result.output,
		files: result.files,
		warnings: [...warnings, ...result.warnings],
	};
}

/** The api surface the runner drives. */
interface SnipCore {
	candidates(): CandidateInventory;
	extract(selector: string, format: OutputFormat, expect?: ExtractExpectation): Promise<ExtractOutcome>;
	schema(): Promise<SchemaResult>;
}

const api: SnipCore = {
	candidates: harvestCandidates,
	extract,
	schema: buildSchema,
};

(globalThis as unknown as { __snipCore: SnipCore }).__snipCore = api;

export { api };
