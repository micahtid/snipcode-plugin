/**
 * core/src/pipeline.ts: the phase order, written once.
 *
 *   reconcile -> features -> denoise -> resolve -> self-contain   (runCoreTransform)
 *   emit(format) -> clean -> assemble -> minimize -> compose      (extractElement)
 *
 * Keeping both sequences here is what stops them drifting. A feature handler that throws is
 * recorded as a warning and the pipeline continues, so one broken mechanism cannot cost the
 * whole snip.
 */
import type { AssetFile, Captured, OutputFormat } from './types';
import { detectBuilder } from './capture/gate';
import { capture } from './capture';
import { reconcile } from './reconcile/bake';
import { denoise } from './reconcile/denoise';
import { reconcileStandalone } from './reconcile/standalone';
import { apply as applyIcons } from './reconcile/features/icons';
import { apply as applyFonts } from './reconcile/features/fonts';
import { apply as applyQueries } from './reconcile/features/queries';
import { apply as applyPseudo } from './reconcile/features/pseudo';
import { apply as applyStates } from './reconcile/features/states';
import { apply as applyImages } from './reconcile/features/images';
import { apply as applyShadow } from './reconcile/features/shadow';
import { apply as applyUnits } from './reconcile/features/units';
import { apply as applyColors } from './reconcile/features/colors';
import { apply as applyAnimation } from './reconcile/features/animation';
import { apply as applyEffects } from './reconcile/features/effects';
import { apply as applyLayers } from './reconcile/features/layers';
import { apply as applyTables } from './reconcile/features/tables';
import { apply as applyLists } from './reconcile/features/lists';
import { apply as applyForms } from './reconcile/features/forms';
import { resolveVariables } from './resolve/vars';
import { resolveFonts, appendGenericFallbacks } from './resolve/fonts';
import { correctFontMime, mergeIdenticalFaces } from './resolve/font-bytes';
import { resolveAnimations } from './resolve/anim';
import { resolveTransitionTiming } from './resolve/transition';
import { inlineResources } from './resolve/inline';
import { composeDocument, type HtmlOutput } from './convert/document';
import { emitTailwind } from './convert/tailwind';
import { emitBem } from './convert/bem';
import { emitJsx } from './convert/jsx';
import { emitVue } from './convert/vue';
import { cleanCss } from './convert/clean';
import { minimizeCss, type MinimizeStats } from './minimize/prune';
import { normalizeCss } from './minimize/normalize';
import { mergeCss } from './minimize/merge';
import { purgeAtRules } from './minimize/atrules';
import { inlineVars } from './minimize/inline';
import { injectReset } from './minimize/reset';
import { foldLogical } from './minimize/logical';
import { foldTransitions } from './minimize/transitions';
import { colorizeCss } from './minimize/colorize';
import { stripUnreferencedDataAttributes } from './minimize/attributes';
import { assembleHtmlDocument, formatCss, isHtmlShaped } from './convert/format';
import { splitAssets } from './convert/assets';

/** The reconcile feature handlers, in apply order. Each covers one mechanism, orthogonally. */
const FEATURE_HANDLERS: Array<[string, (c: Captured) => Captured]> = [
	['icons', applyIcons],
	['fonts', applyFonts],
	['queries', applyQueries],
	['pseudo', applyPseudo],
	['states', applyStates],
	['images', applyImages],
	['shadow', applyShadow],
	['units', applyUnits],
	['colors', applyColors],
	['animation', applyAnimation],
	['effects', applyEffects],
	['layers', applyLayers],
	['tables', applyTables],
	['lists', applyLists],
	['forms', applyForms],
];

/** Runs every feature handler, isolating failures: a throw becomes a warning and flows on. */
function runFeatures(captured: Captured): void {
	for (const [name, fn] of FEATURE_HANDLERS) {
		try {
			fn(captured);
		} catch (err) {
			captured.warnings.push(`feature ${name} failed: ${(err as Error).message}`);
		}
	}
}

/** Runs reconcile, resolve, and self-containment, turning a capture into a standalone clone. */
export async function runCoreTransform(captured: Captured): Promise<void> {
	// Reconcile. Authored and inherited styles bake onto the clone, the feature handlers run
	// over the result, then de-noise drops the inert declarations they baked.
	reconcile(captured);
	runFeatures(captured);
	denoise(captured);

	// Resolve. Vars first, since they rewrite values, then fonts and keyframes, which read the
	// now-stable baked styles.
	resolveVariables(captured);
	resolveFonts(captured);
	resolveAnimations(captured);
	// Var resolution can collapse a cycled timing sub-list to one literal against a
	// multi-entry transition-property, so re-expand it and keep the fold lossless.
	resolveTransitionTiming(captured);

	// Closing reconciliation: the artifact's own render becomes the source of truth. Last, so
	// it corrects anything resolve left dangling.
	reconcileStandalone(captured);
	// Self-containment: every font stack ends in a generic, then the referenced fonts and
	// images inline as data uris so the artifact depends on no origin.
	appendGenericFallbacks(captured);
	await inlineResources(captured);
	// Post-embed: relabel each font data uri with the mime its bytes are, then collapse faces
	// with identical bytes into one weight-range @font-face.
	correctFontMime(captured);
	mergeIdenticalFaces(captured);
}

/**
 * Runs the minimize pipeline over an assembled html-shaped artifact. Every css step degrades
 * to its input on failure, so the result is always shippable.
 */
export async function minimizeArtifact(
	captured: Captured,
	html: string,
	css: string,
	stats?: MinimizeStats,
): Promise<{ html: string; css: string }> {
	const pruned = await minimizeCss(css, captured, html, stats);
	const normalized = await normalizeCss(await foldLogical(pruned, captured, html), captured, html);
	const folded = foldTransitions(normalized);
	const merged = await mergeCss(folded, captured, html);
	const purged = purgeAtRules(merged);
	const inlined = purgeAtRules(await inlineVars(purged, captured, html));
	const reset = await injectReset(inlined, captured, html);
	const deduped = reset === inlined ? inlined : await minimizeCss(reset, captured, html);
	const colored = colorizeCss(formatCss(deduped));
	const finalCss = colorizeCss(formatCss(await mergeCss(colored, captured, html)));
	return { html: stripUnreferencedDataAttributes(html, finalCss), css: finalCss };
}

/** Dispatches to one format's emitter. Each is a pure transform of the same Captured. */
export function emitFormat(captured: Captured, format: OutputFormat): HtmlOutput {
	switch (format) {
		case 'tailwind':
			return emitTailwind(captured);
		case 'html':
		case 'bem-css':
			return emitBem(captured);
		case 'jsx-tailwind':
			return emitJsx(captured);
		case 'vue':
			return emitVue(captured);
	}
}

/** The self-contained result of extracting one element. */
export interface ExtractResult {
	/** Whether the builder gate refused this element (Framer, Wix, etc.). */
	builderDetected: boolean;
	/** The builder name when builderDetected, else null. */
	builder: string | null;
	/** The element markup fragment. */
	html: string;
	/** The stylesheet, minimized for the class-based formats. */
	css: string;
	/** The composed single-file artifact (markup + stylesheet). */
	output: string;
	/** Lifted inline svgs and data-uri images, for the class-based formats. */
	files?: AssetFile[];
	/** Non-fatal warnings accumulated across the pipeline. */
	warnings: string[];
}

/**
 * Runs the full pipeline for one resolved element and returns a self-contained artifact in the
 * chosen format. Every judgment layer stays with the calling agent.
 *
 * @param screenshot - cropped png data url, may be empty
 */
export async function extractElement(root: Element, screenshot: string, format: OutputFormat): Promise<ExtractResult> {
	// Builder gate, before any capture work. On a hit the agent gets the screenshot crop and
	// rebuilds the element by eye.
	const gate = detectBuilder(root);
	if (gate.blocked) {
		return { builderDetected: true, builder: gate.builder ?? null, html: '', css: '', output: '', warnings: [gate.message ?? 'unsupported builder site'] };
	}

	const captured = await capture(root, screenshot);
	await runCoreTransform(captured);

	const emitted = emitFormat(captured, format);
	// The bem emitters, html included, put generated classes on a private copy, so the cleaner
	// matches against the emitted markup. tailwind, jsx, and vue match the clone.
	const classMarkup = format === 'html' || format === 'bem-css' ? emitted.html : undefined;
	let css = cleanCss(emitted.css, captured, classMarkup);
	let html = emitted.html;

	if (isHtmlShaped(format)) {
		const assembled = assembleHtmlDocument(html, css, captured.warnings);
		html = assembled.html;
		css = assembled.css;
		// Minimize phase, deterministic and key-free, class-based formats only.
		if (classMarkup !== undefined) {
			const minimized = await minimizeArtifact(captured, assembled.html, assembled.css);
			html = minimized.html;
			css = minimized.css;
		}
	}

	const output = composeDocument(html, css);
	// Delivery split: lift inline svgs and data-uri images into their own referenced files.
	const files = isHtmlShaped(format) ? splitAssets(output, captured.warnings) : undefined;

	return {
		builderDetected: false,
		builder: null,
		html,
		css,
		output,
		warnings: captured.warnings,
		...(files ? { files } : {}),
	};
}
