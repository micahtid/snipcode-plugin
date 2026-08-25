/**
 * features/pseudo.ts: generated-content pseudo-elements.
 *
 * ::before and ::after content, styled ::marker, ::placeholder, and ::file-selector-button
 * render no dom node, so a clone loses them entirely. An inline style cannot target a
 * pseudo-element, so the faithful fix is a real rule. The element is tagged and a
 * `[data-snip-pseudo="n"]::x` rule joins the shared synthesized <style>.
 *
 * The marker is a data-* attribute rather than a class, because the tailwind and bem emitters
 * rewrite class and keep data-*.
 */
import type { Captured } from '../../types';
import { pairedSubtrees, transformContext } from '../match';
import { pseudoDefaults, isDroppableDecl } from '../denoise';
import { appendSynthesizedRules } from '../synthesized';

const MARKER = 'data-snip-pseudo';

/**
 * The visual properties snapshotted for a pseudo-element. This is the bounded
 * css-spec surface that defines a generated box's appearance.
 */
const PSEUDO_PROPS = [
	'content', 'display', 'position', 'top', 'right', 'bottom', 'left',
	'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
	'margin', 'padding', 'color', 'background', 'border', 'border-radius', 'box-shadow',
	'font', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'text-decoration',
	'white-space', 'opacity', 'transform', 'transform-origin', 'transition', 'z-index',
	'overflow', 'vertical-align', 'list-style-type', '-webkit-text-fill-color', 'background-clip',
];

/** Materializes generated-content pseudo-elements as css rules on the clone. Clone is mutated in place. */
export function apply(captured: Captured): Captured {
	const rules: string[] = [];
	let counter = 0;

	for (const [original, clone] of pairedSubtrees(captured.root, captured.clone)) {
		const pseudos = pseudosFor(original);
		const elementRules: string[] = [];
		for (const pseudo of pseudos) {
			const rule = ruleFor(original, clone, pseudo, counter, captured);
			if (rule) elementRules.push(rule);
		}
		if (elementRules.length > 0) {
			clone.setAttribute(MARKER, String(counter));
			rules.push(...elementRules);
			counter++;
		}
	}

	appendSynthesizedRules(captured, rules);
	return captured;
}

/** Which pseudo-elements are worth emitting for this element. */
function pseudosFor(el: Element): string[] {
	const out: string[] = [];
	if (hasContent(el, '::before')) out.push('::before');
	if (hasContent(el, '::after')) out.push('::after');
	// A styled list marker only renders on display:list-item, which is a spec mechanism rather than a tag check.
	if (getComputedStyle(el).display === 'list-item') out.push('::marker');
	// A placeholder pseudo only exists where a placeholder attribute does.
	if (el.hasAttribute('placeholder')) out.push('::placeholder');
	try {
		if (el.matches('input[type="file"]')) out.push('::file-selector-button');
	} catch {
		// Matches unsupported, so ignore.
	}
	return out;
}

/** True when a ::before/::after actually generates a box, meaning content is not `none`. */
function hasContent(el: Element, pseudo: string): boolean {
	const content = getComputedStyle(el, pseudo).getPropertyValue('content');
	return content !== '' && content !== 'none' && content !== 'normal';
}

/** Build one `[data-snip-pseudo="n"]pseudo {... }` rule from the live pseudo's computed style. */
function ruleFor(el: Element, clone: Element, pseudo: string, id: number, captured: Captured): string | null {
	const computed = getComputedStyle(el, pseudo);
	// Every pseudo is de-noised against the ground truth the element pass uses. A non-inherited
	// value falls back to the ua default for this pseudo on this element, read from a clean
	// iframe probe with the page's author rules stripped. An inherited one falls back to the
	// originating element's effective snip value, never the live page. That drops the inert
	// noise, list-style-type: disc and vertical-align: baseline, while keeping the real
	// ::placeholder and ::marker appearance.
	const defaults = pseudoDefaults(el, pseudo);
	const box = transformContext(computed);
	// Generated content is load-bearing for the box-generating pseudos and is always
	// kept. For ::placeholder and ::file-selector-button, content is just `normal`
	// noise, so it falls through to the inert-keyword check below and drops.
	const keepContent = pseudo === '::before' || pseudo === '::after' || pseudo === '::marker';

	const decls: string[] = [];
	for (const prop of PSEUDO_PROPS) {
		const value = computed.getPropertyValue(prop);
		if (!value) continue;
		if (prop === 'content' && keepContent) {
			decls.push(`\t${prop}: ${value};`);
			continue;
		}
		// The universally-inert keywords carry no box, spacing, or decoration.
		if (value === 'normal' || value === 'auto' || value === 'none') continue;
		if (!isDroppableDecl(captured, clone, prop, value, defaults, box)) decls.push(`\t${prop}: ${value};`);
	}
	if (decls.length === 0) return null;
	return `[${MARKER}="${id}"]${pseudo} {\n${decls.join('\n')}\n}`;
}
