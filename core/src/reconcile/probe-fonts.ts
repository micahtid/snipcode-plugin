/**
 * reconcile/probe-fonts.ts: the web faces the artifact ships but cannot resolve
 *
 * Pipeline position: reconcile, a detection-only helper for the standalone probe
 * Reads from Captured: root, fonts, page.viewport
 * Writes to Captured: nothing. Nothing here mutates, and no emitted byte changes.
 *
 * Why this exists: computed style is blind to whether a font actually loads. Live and
 * standalone both report the same requested family string while only the live element
 * paints it, so a missing web font is invisible to the property diff next door. This asks
 * the layer below: mount the artifact's own @font-face rules in an isolated frame and ask
 * that frame's FontFaceSet to load each face the live subtree really renders. An empty
 * match is a discovery gap, a failed load is an inlining gap, and both mean the artifact
 * would paint the wrong font.
 */
import type { Captured, FontFace } from '../types';
import { createSizedFrame } from './frame';

/** One web face the live subtree renders, normalized for a FontFaceSet.load() request. */
interface RenderedFace {
	family: string;
	weight: string; // Numeric css weight from computed style, e.g. "400" or "700".
	style: string; // 'normal' | 'italic' | 'oblique'.
}

/**
 * Counts the web faces the standalone artifact fails to resolve. Builds an isolated
 * frame carrying only the snip's own captured @font-face rules (the exact faces the
 * artifact ships), then for each web face the live subtree renders asks the frame's
 * FontFaceSet to load it. An empty result means the family is absent from the artifact,
 * a discovery gap. A rejection or an unloaded face means a declared face could not be
 * fetched, an inlining gap. Either way the artifact would render the wrong font, so it
 * is counted. Nothing is mutated and no emitted byte changes.
 *
 * Scope is the live FontFaceSet: only families the page actually loaded as a web font
 * are checked, so correctly-rendered system and generic text (Arial, system-ui) is
 * never counted, with no family list anywhere.
 *
 * Determinism note: while a captured face still carries an external src, the frame's
 * load() reaches the network, so the count is fully deterministic only once faces are
 * inlined as data uris in resolve/inline.ts. The discovery gap, zero faces for a rendered
 * family, reads the same offline or online.
 *
 * @param captured - the reconciled capture (read-only)
 */
export async function probeUnresolvedFonts(captured: Captured): Promise<number> {
	const webFamilies = liveWebFontFamilies();
	if (webFamilies.size === 0) return 0;
	const faces = renderedWebFaces(captured.root, webFamilies);
	if (faces.length === 0) return 0;

	const sized = createSizedFrame(captured);
	try {
		if (captured.fonts.length > 0) {
			const style = sized.doc.createElement('style');
			style.textContent = captured.fonts.map(fontFaceRule).join('\n');
			sized.doc.head.appendChild(style);
		}
		let unresolved = 0;
		for (const face of faces) {
			if (!(await faceResolves(sized.win, face))) unresolved++;
		}
		return unresolved;
	} finally {
		sized.frame.remove();
	}
}

/**
 * The web-font families the live page actually loaded, lowercased. A family is a web
 * font when the live document's FontFaceSet holds a face for it. System and generic
 * families never appear there, so they fall out without being named. This scopes the
 * resolution check to the fonts the snip is responsible for carrying.
 */
function liveWebFontFamilies(): Set<string> {
	const out = new Set<string>();
	try {
		document.fonts.forEach((face) => {
			const family = face.family.replace(/^["']|["']$/g, '').trim().toLowerCase();
			if (family) out.add(family);
		});
	} catch {
		// FontFaceSet unavailable, so treat the page as carrying no web fonts.
	}
	return out;
}

/**
 * The distinct (family, weight, style) web faces the live subtree renders. Reads the
 * first family of each element's computed font stack, the one that actually renders,
 * paired with the weight and style it renders at, keeping only families the live page
 * loaded as a web font. Deduped so each face is counted once.
 *
 * @param root - the live snip root
 * @param webFamilies - lowercased families from the live FontFaceSet
 */
function renderedWebFaces(root: Element, webFamilies: Set<string>): RenderedFace[] {
	const seen = new Set<string>();
	const out: RenderedFace[] = [];
	for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
		const cs = getComputedStyle(el);
		const family = (cs.fontFamily.split(',')[0] ?? '').replace(/^["']|["']$/g, '').trim();
		if (!family || !webFamilies.has(family.toLowerCase())) continue;
		const rawStyle = cs.fontStyle || 'normal';
		const style = rawStyle.startsWith('italic') ? 'italic' : rawStyle.startsWith('oblique') ? 'oblique' : 'normal';
		const weight = cs.fontWeight || '400';
		const key = `${family.toLowerCase()}|${weight}|${style}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ family, weight, style });
	}
	return out;
}

/** Whether the frame's FontFaceSet resolves a face: false on an empty match or load failure. */
async function faceResolves(win: Window, face: RenderedFace): Promise<boolean> {
	try {
		const request = `${face.weight} ${face.style} 16px "${face.family.replace(/"/g, '\\"')}"`;
		const loaded = await win.document.fonts.load(request);
		return loaded.length > 0 && loaded.every((f) => f.status === 'loaded');
	} catch {
		return false;
	}
}

/** Serializes a captured face back to an @font-face rule for injection into the probe frame. */
function fontFaceRule(font: FontFace): string {
	const descriptors = Object.entries(font.descriptors).map(([prop, value]) => `${prop}:${value};`).join('');
	return `@font-face{font-family:"${font.family.replace(/"/g, '\\"')}";src:${font.src};${descriptors}}`;
}
