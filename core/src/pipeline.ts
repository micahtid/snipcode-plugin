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
import { resolveFonts, appendGenericFallbacks, correctFontMime, mergeIdenticalFaces } from './resolve/fonts';
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

/**
 * The reconcile-phase feature handlers, in apply order. Each handles one css/html
 * spec mechanism universally and is orthogonal to the others.
 */
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

/**
 * Runs every feature handler over the captured snip, isolating failures. A handler
 * that throws never halts the pipeline: the error is recorded as a warning and the
 * unmodified captured flows on.
 */
function runFeatures(captured: Captured): void {
	for (const [name, fn] of FEATURE_HANDLERS) {
		try {
			fn(captured);
		} catch (err) {
			captured.warnings.push(`feature ${name} failed: ${(err as Error).message}`);
		}
	}
}

/**
 * Runs the reconcile, resolve, and self-containment transform that turns a captured
 * snip into a self-contained clone.
 */
export async function runCoreTransform(captured: Captured): Promise<void> {
	// Reconcile phase. Authored and inherited styles bake onto the clone, the feature
	// handlers run over the result with isolated failures, then de-noise drops the inert
	// declarations they bake so every output format ships the smaller result.
	reconcile(captured);
	runFeatures(captured);
	denoise(captured);

	// Resolve phase. Var resolution in a single pass, @font-face absolutization,
	// @keyframes pairing. Order: vars first, which may rewrite values, then
	// fonts/keyframes which read the now-stable baked styles.
	resolveVariables(captured);
	resolveFonts(captured);
	resolveAnimations(captured);
	// Var resolution can collapse a cycled transition timing sub-list to one literal
	// against a multi-entry transition-property, which would serialize to a malformed
	// shorthand. Re-expand the sub-lists so the fold stays lossless.
	resolveTransitionTiming(captured);

	// Closing reconciliation: make the standalone artifact's own render the source of
	// truth, baking the original's resolved value for any paint/box property that does
	// not reproduce standalone. Runs last so it corrects anything resolve left dangling.
	reconcileStandalone(captured);
	// Self-containment: guarantee every font stack ends in a generic, then inline the
	// referenced fonts and images as data uris so the artifact does not depend on the origin.
	appendGenericFallbacks(captured);
	await inlineResources(captured);
	// Post-embed font sanity: relabel each font data uri with the mime its bytes actually are,
	// then collapse faces that embed identical bytes into one weight-range @font-face.
	correctFontMime(captured);
	mergeIdenticalFaces(captured);
}

/**
 * Runs the deterministic, key-free minimize pipeline over an assembled html-shaped
 * artifact. Every css step degrades to its input on failure, so the pipeline always
 * produces a shippable pair.
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

/**
 * Dispatches to the emitter for the chosen output format. Every format is a pure
 * transform of the same Captured, so all are derivable from one capture.
 */
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
 * Runs the full deterministic pipeline for one already-resolved element and returns
 * a self-contained artifact in the chosen format. Every judgment layer, including which
 * element to pick and what to name it, stays with the calling agent.
 *
 * @param screenshot - cropped png data url, may be empty
 */
export async function extractElement(root: Element, screenshot: string, format: OutputFormat): Promise<ExtractResult> {
	// Builder gate: refuse framer/wix/etc before any capture work. On a hit the agent
	// gets the element screenshot crop and rebuilds it with a vision model itself.
	const gate = detectBuilder(root);
	if (gate.blocked) {
		return { builderDetected: true, builder: gate.builder ?? null, html: '', css: '', output: '', warnings: [gate.message ?? 'unsupported builder site'] };
	}

	const captured = await capture(root, screenshot);
	await runCoreTransform(captured);

	const emitted = emitFormat(captured, format);
	// The bem emitters (including the html format) put generated classes on a private
	// copy, so the cleaner matches selectors against the emitted markup; tailwind/jsx/vue
	// keep matching against the inline-styled clone.
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
	// Delivery split for the self-contained html-shaped output: lift inline svgs and
	// data-uri images into their own referenced files.
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
