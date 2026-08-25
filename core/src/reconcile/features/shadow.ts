/**
 * features/shadow.ts: flattening open shadow trees into light dom.
 *
 * cloneNode(true) does not copy shadow roots, so a web component's entire rendered content and
 * its scoped styles vanish. For each open host this inlines the shadow's adoptedStyleSheets
 * and <style> css with :host rescoped to a marker, then appends a clone of the shadow tree.
 *
 * Shadow content is appended after the host's light children, which keeps pairedSubtrees
 * aligned for the later handlers. Slot distribution is approximated, and ::part and ::slotted
 * ride along verbatim. A closed root cannot be read at all, so capture counts it and warns.
 */
import type { Captured } from '../../types';
import { pairedSubtrees } from '../match';

/** Flattens open shadow trees and their scoped styles into the clone. Clone is mutated in place. */
export function apply(captured: Captured): Captured {
	let hostId = 0;
	let sawShadow = false;

	for (const [original, clone] of pairedSubtrees(captured.root, captured.clone)) {
		const shadow = (original as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
		if (!shadow) continue; // No open shadow root, and closed roots read as null here
		sawShadow = true;

		const id = hostId++;
		clone.setAttribute('data-snip-host', String(id));
		const css = collectShadowCss(shadow);
		if (css) {
			const style = document.createElement('style');
			// Rescope :host to the host marker so the styles apply in light dom.
			style.textContent = css.replace(/:host(\([^)]*\))?/g, `[data-snip-host="${id}"]`);
			clone.appendChild(style);
		}
		// Append the rendered shadow markup after the host's light children.
		for (const child of Array.from(shadow.children)) {
			clone.appendChild(child.cloneNode(true));
		}
	}

	if (!sawShadow && captured.inaccessible.closedShadowRoots > 0) {
		captured.warnings.push(`shadow: ${captured.inaccessible.closedShadowRoots} closed shadow root(s) could not be flattened`);
	}
	return captured;
}

/** Concatenate a shadow root's adopted and inline stylesheet css. */
function collectShadowCss(shadow: ShadowRoot): string {
	const parts: string[] = [];
	// Constructable stylesheets attached via adoptedStyleSheets.
	for (const sheet of shadow.adoptedStyleSheets ?? []) {
		try {
			for (const rule of Array.from(sheet.cssRules)) parts.push(rule.cssText);
		} catch {
			// Cross-origin constructable sheet, rare, so skip it.
		}
	}
	// Inline <style> blocks inside the shadow root.
	for (const styleEl of Array.from(shadow.querySelectorAll('style'))) {
		if (styleEl.textContent) parts.push(styleEl.textContent);
	}
	return parts.join('\n');
}
