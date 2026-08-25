/**
 * core/src/capture.ts: the capture phase, in order.
 *
 * Settles the element, clones it, and reads the page's stylesheets. It then adds, through the
 * Host, the two reads the page context cannot make: the authored ancestor cascade and the
 * cross-origin sheets. The result is the Captured object every later phase mutates.
 */
import type { Captured } from './types';
import { buildElementMetadata, cloneElement } from './capture/dom';
import { settle } from './capture/settle';
import { discoverStylesheets } from './capture/sheets';
import { augmentInheritedChainViaCDP, recoverCrossOriginSheets, recoverCrossOriginFontsViaCDP } from './capture/cdp';
import { measureInteractiveStates } from './capture/states-measure';

/**
 * Runs the capture phase, assembling the Captured object every later phase reads.
 *
 * @param screenshot - cropped png data url from the runner, may be empty
 */
export async function capture(root: Element, screenshot: string): Promise<Captured> {
	// Settle first, before anything is read or cloned, so the snip reflects what a human sees
	// rather than a transient pre-reveal frame.
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
	// Fallback for the @font-face rules the re-fetch could not get, when a cdn waf blocks it.
	await recoverCrossOriginFontsViaCDP(captured);
	// Measure interactive states by forcing them live, soft-failing to copied rules when cdp is
	// busy. After the clone, so the transient force and shim never reach the artifact.
	await measureInteractiveStates(captured);

	return captured;
}
