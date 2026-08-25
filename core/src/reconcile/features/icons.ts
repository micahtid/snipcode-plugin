/**
 * features/icons.ts: resolving svg sprite references.
 *
 * A design system keeps icons as <symbol> definitions in a sprite outside the picked subtree.
 * Every <use href="#x"> then renders as a blank 0x0 box once the snip is pasted elsewhere. So
 * this reads the referenced symbols from the live document and inlines them in a hidden <defs>
 * at the top of the clone. currentColor keeps working because bake.ts already baked color onto
 * the snip root.
 */
import type { Captured } from '../../types';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** Inlines the <symbol> definitions the clone's <use> elements reference. Clone mutates here. */
export function apply(captured: Captured): Captured {
	const uses = Array.from(captured.clone.querySelectorAll('use'));
	if (uses.length === 0) return captured; // No sprite refs, nothing to do

	const wantedIds = new Set<string>();
	for (const use of uses) {
		const ref = use.getAttribute('href') ?? use.getAttributeNS(XLINK_NS, 'href') ?? use.getAttribute('xlink:href');
		if (ref && ref.startsWith('#')) wantedIds.add(ref.slice(1));
	}
	if (wantedIds.size === 0) return captured; // Only external refs, cannot inline

	const symbols: Element[] = [];
	for (const id of wantedIds) {
		// Symbols are global ids, so getElementById finds one outside the picked subtree,
		// which is the whole point.
		const found = document.getElementById(id);
		if (found) symbols.push(found.cloneNode(true) as Element);
		else captured.warnings.push(`icons: sprite symbol #${id} not found in document`);
	}
	if (symbols.length === 0) return captured;

	// A single hidden svg carrying the referenced symbols, prepended so the refs
	// resolve before they are used.
	const sprite = document.createElementNS(SVG_NS, 'svg');
	sprite.setAttribute('aria-hidden', 'true');
	sprite.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
	const defs = document.createElementNS(SVG_NS, 'defs');
	for (const sym of symbols) defs.appendChild(sym);
	sprite.appendChild(defs);
	captured.clone.insertBefore(sprite, captured.clone.firstChild);

	return captured;
}
