/**
 * core/src/capture.ts: the capture phase, ported from the extension orchestrator.
 *
 * Drives the picked element to its settled state, clones it, discovers the page's
 * stylesheets, and augments the clone with the privileged data only the host can
 * reach (the authored inherited cascade, cross-origin sheets and fonts, forced
 * interactive states). Produces the Captured object every later phase reads.
 *
 * This is the extension's capture() lifted verbatim except for two things: the
 * screenshot arrives from the runner rather than the picker, and the privileged
 * augmentation goes through the Host seam rather than chrome messages.
 */
import type { Captured } from './types';
import { buildElementMetadata, cloneElement } from './capture/dom';
import { settle } from './capture/settle';
import { discoverStylesheets } from './capture/sheets';
import { augmentInheritedChainViaCDP, recoverCrossOriginSheets, recoverCrossOriginFontsViaCDP } from './capture/cdp';
import { measureInteractiveStates } from './capture/states-measure';

/**
 * Runs the capture phase on the chosen element, assembling the shared Captured
 * object every later phase reads.
 *
 * @param root - the live element to snip
 * @param screenshot - cropped png data url from the runner, may be empty
 * @returns the populated Captured object
 */
export async function capture(root: Element, screenshot: string): Promise<Captured> {
	// Settle first: drive the element to its revealed, loaded state before anything is
	// read or cloned, so the snip reflects what a human sees rather than a transient
	// pre-reveal frame. Runs ahead of the clone and every computed-style read below.
	const settled = await settle(root);

	const sheets = discoverStylesheets();
	const captured: Captured = {
		page: {
			url: location.href,
			title: document.title,
			viewport: {
				width: window.innerWidth,
				height: window.innerHeight,
				devicePixelRatio: window.devicePixelRatio || 1,
			},
			userAgent: navigator.userAgent,
		},
		capturedAt: new Date().toISOString(),
		element: buildElementMetadata(root),
		screenshot,
		root,
		clone: cloneElement(root),
		stylesheets: sheets.stylesheets,
		foundationRules: sheets.foundationRules,
		componentRules: sheets.componentRules,
		variables: sheets.variables,
		fonts: sheets.fonts,
		keyframes: sheets.keyframes,
		inaccessible: {
			crossOriginStylesheets: sheets.crossOriginStylesheets,
			closedShadowRoots: 0, // Cdp shadow-pierce fills this in.
		},
		bakedStyles: new Map(),
		measuredStates: null, // measureInteractiveStates fills this in. Null means not measured.
		warnings: settled.warning ? [settled.warning] : [],
	};

	// Privileged augmentation, host-mediated. Each soft-fails: the snip proceeds on
	// cssom-only data if the host refuses a cdp attach or a fetch is blocked.
	await augmentInheritedChainViaCDP(captured); // inherited cascade via cdp
	await recoverCrossOriginSheets(captured); // Recover cors-blocked sheets by privileged re-fetch
	// Fallback for the @font-face rules the re-fetch could not get, such as when a cdn waf blocks
	// the fetch. Read the sheet text the browser already parsed over cdp.
	await recoverCrossOriginFontsViaCDP(captured);
	// Measure interactive states by forcing them live. Soft-fails to copying authored rules
	// if cdp is busy. Runs after the clone is taken, so the transient force/shim it applies
	// to the live page never reaches the artifact.
	await measureInteractiveStates(captured);

	return captured;
}
