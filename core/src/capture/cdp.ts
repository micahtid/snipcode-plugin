/**
 * capture/cdp.ts: the two reads the page context cannot make.
 *
 * Runs during capture, through the Host. One is the authored ancestor cascade, what devtools
 * shows as "inherited from", which only the protocol exposes and which bake.ts later bakes
 * onto the snip root. The other is the cross-origin sheets the same-origin policy blocks.
 * DOM.getDocument runs with pierce, so the inherited chain resolves through closed shadow roots.
 */
import type { Captured, CssRule } from '../types';
import { parseCssText, specificityOf } from './sheets';
import { getHost } from '../host';

/** Temporary marker attribute so the host can resolve the live node by selector. */
const TAG_ATTR = 'data-snipcode-target';

/**
 * Adds the authored inherited cascade to Captured. It tags the live root, asks the host to read
 * CSS.getMatchedStylesForNode().inherited for that node, and folds the ancestor rules into
 * foundationRules. Soft-fails: a busy or refused debugger leaves the snip on cssom data alone
 * with a warning, because cdp is an enhancement rather than a dependency.
 *
 * @param captured - the in-flight capture, mutated in place
 */
export async function augmentInheritedChainViaCDP(captured: Captured): Promise<void> {
	const root = captured.root;
	const token = `t${Math.floor(performance.now())}${root.tagName.length}`;
	root.setAttribute(TAG_ATTR, token);
	const selector = `[${TAG_ATTR}="${token}"]`;
	try {
		const res = await getHost().cdpInherited(selector);

		if (!res?.ok || !res.result) {
			captured.warnings.push(`cdp inherited chain unavailable: ${res?.error?.message ?? 'no response'}`);
			return;
		}
		const { inherited, closedShadowRoots, warning } = res.result;
		if (warning) captured.warnings.push(warning);
		// Pierce:true means cdp saw the closed roots, so record how many for transparency.
		captured.inaccessible.closedShadowRoots = closedShadowRoots;

		for (const rule of inherited) {
			const properties = new Map(Object.entries(rule.properties));
			const entry: CssRule = {
				selector: rule.selector,
				properties,
				specificity: specificityOf(rule.selector),
				source: 'cdp',
				...(rule.media ? { mediaQuery: rule.media } : {}),
			};
			// Inherited ancestor rules apply broadly, so they live in the foundation layer.
			captured.foundationRules.push(entry);
		}
	} catch (err) {
		captured.warnings.push(`cdp inherited chain failed: ${(err as Error).message}`);
	} finally {
		root.removeAttribute(TAG_ATTR);
	}
}

/**
 * Recovers the cross-origin stylesheets sheets.ts recorded as unreadable, by fetching each
 * through the privileged host, parsing the text, and merging the rules in. A recovered href
 * leaves the inaccessible list; a failure stays on it with a warning rather than blocking.
 *
 * @param captured - the in-flight capture, mutated in place
 */
export async function recoverCrossOriginSheets(captured: Captured): Promise<void> {
	const pending = captured.inaccessible.crossOriginStylesheets;
	if (pending.length === 0) return;
	const stillInaccessible: string[] = [];

	for (const href of pending) {
		try {
			const res = await getHost().fetchStylesheet(href);

			if (!res?.ok || !res.result?.text) {
				stillInaccessible.push(href);
				captured.warnings.push(`cross-origin stylesheet unreadable: ${href}`);
				continue;
			}
			const delta = await parseCssText(res.result.text, 'cssom', href);
			captured.foundationRules.push(...delta.foundationRules);
			captured.componentRules.push(...delta.componentRules);
			captured.variables.push(...delta.variables);
			captured.fonts.push(...delta.fonts);
			captured.keyframes.push(...delta.keyframes);
			captured.stylesheets.push({ href, origin: 'cross-origin', ruleCount: delta.componentRules.length + delta.foundationRules.length });
		} catch (err) {
			stillInaccessible.push(href);
			captured.warnings.push(`cross-origin fetch failed for ${href}: ${(err as Error).message}`);
		}
	}
	captured.inaccessible.crossOriginStylesheets = stillInaccessible;
}

/**
 * Recovers the @font-face rules a cross-origin stylesheet hides, by reading the text the
 * browser already parsed over cdp. A cdn waf often blocks the privileged re-fetch above. The
 * protocol is not bound by the same-origin policy and needs no network round-trip. So this
 * runs over the hrefs still flagged inaccessible, closing the font gap those sites leave.
 *
 * Scope is @font-face only. Fonts are a resource the artifact must carry; the full cross-origin
 * cascade is not the goal, so the inaccessible list is left untouched. parseCssText absolutizes
 * each recovered src against the sheet href, so a relative src on a cdn-hosted sheet resolves
 * to the cdn rather than the page origin.
 *
 * @param captured - the in-flight capture. captured.fonts is extended in place
 */
export async function recoverCrossOriginFontsViaCDP(captured: Captured): Promise<void> {
	const pending = captured.inaccessible.crossOriginStylesheets;
	if (pending.length === 0) return;
	try {
		const res = await getHost().cdpStylesheets(pending);

		if (!res?.ok || !res.result?.sheets?.length) return; // Nothing recovered, so leave the list as-is.
		for (const sheet of res.result.sheets) {
			try {
				const delta = await parseCssText(sheet.text, 'cdp', sheet.href);
				captured.fonts.push(...delta.fonts);
			} catch (err) {
				captured.warnings.push(`cdp font recovery parse failed for ${sheet.href}: ${(err as Error).message}`);
			}
		}
	} catch (err) {
		captured.warnings.push(`cdp font recovery failed: ${(err as Error).message}`);
	}
}
