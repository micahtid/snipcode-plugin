/**
 * inspect/schema/structure.ts: the deduped style map, the structure tree, and the state rules
 *
 * Pipeline position: inspect, page-scoped. See inspect/schema/extract.ts for the whole pass.
 * Reads from DOM: element geometry, for the image placeholder sizes.
 * Writes to: nothing.
 *
 * Why this exists: the schema has to describe the page's shape without shipping the page.
 * Two moves do that. Every distinct fingerprint becomes one numbered style entry, so a
 * thousand elements resolve to a few dozen styles, and the tree that references them carries
 * placeholder tokens instead of real copy. The state pass alongside them lifts the
 * hover/focus/active rules the resting styles cannot show, which is what lets a redesign
 * reproduce the page's interactive feel.
 */
import type { WalkedElement } from './shared';
import type { SchemaNode, StateRule } from './types';

/** Lifts hover/focus/active rules from the stylesheets that target walked elements. */
export function extractStates(rules: CSSRule[], walked: WalkedElement[]): StateRule[] {
	const states: StateRule[] = [];
	const statePattern = /:(?:hover|focus|active|focus-visible)/;
	const walkedSelectors = new Set<string>();
	for (const el of walked) {
		for (const cls of Array.from(el.element.classList)) walkedSelectors.add(`.${cls}`);
	}

	for (const rule of rules) {
		if (!(rule instanceof CSSStyleRule)) continue;
		const selector = rule.selectorText;
		if (!statePattern.test(selector)) continue;

		const stateMatch = selector.match(/:(?:hover|focus|active|focus-visible)/);
		if (!stateMatch) continue;
		const state = stateMatch[0].slice(1) as StateRule['state'];

		const baseSelector = selector.replace(/:(?:hover|focus|active|focus-visible)/g, '').trim();
		let matches = false;
		for (const cls of walkedSelectors) {
			if (baseSelector.includes(cls)) {
				matches = true;
				break;
			}
		}
		if (!matches) continue;

		const changes: Record<string, string> = {};
		for (let i = 0; i < rule.style.length; i++) {
			const prop = rule.style[i]!;
			changes[prop] = rule.style.getPropertyValue(prop);
		}
		if (Object.keys(changes).length > 0) states.push({ selector, state, changes });
	}

	return states.slice(0, 30);
}

/** Builds the deduped style map, one entry per fingerprint, and the structure tree. */
export function assemble(walked: WalkedElement[]): { styles: Record<string, Record<string, string>>; structure: SchemaNode[] } {
	const styleMap: Record<string, Record<string, string>> = {};
	const fingerprintToId = new Map<string, string>();
	let styleCounter = 0;

	for (const el of walked) {
		if (!el.fingerprint || fingerprintToId.has(el.fingerprint)) continue;
		if (Object.keys(el.properties).length === 0) continue;
		styleCounter++;
		const id = `s${styleCounter}`;
		fingerprintToId.set(el.fingerprint, id);
		styleMap[id] = el.properties;
	}

	const structure = buildTree(walked, fingerprintToId, 0, null, 4);
	return {
		styles: Object.fromEntries(Object.entries(styleMap).slice(0, 80)),
		structure: structure.slice(0, 50),
	};
}

/** Builds the nested structure tree of walked elements down to maxDepth. */
function buildTree(walked: WalkedElement[], fingerprintToId: Map<string, string>, depth: number, parent: Element | null, maxDepth: number): SchemaNode[] {
	if (depth >= maxDepth) return [];

	const nodes: SchemaNode[] = [];
	for (const el of walked.filter((e) => e.parent === parent)) {
		const node: SchemaNode = { tag: el.tag, role: el.role };
		const styleRef = fingerprintToId.get(el.fingerprint);
		if (styleRef) node.s = styleRef;
		const textPlaceholder = getTextPlaceholder(el);
		if (textPlaceholder) node.text = textPlaceholder;
		if (el.repeat && el.repeat > 1) node.repeat = el.repeat;
		const childNodes = buildTree(walked, fingerprintToId, depth + 1, el.element, maxDepth);
		if (childNodes.length > 0) node.children = childNodes;
		nodes.push(node);
	}
	return nodes;
}

/** A text placeholder token for an element's role, e.g. "{h1}", "{btn}", "{img 200x80}". */
function getTextPlaceholder(el: WalkedElement): string | undefined {
	switch (el.role) {
		case 'heading': return `{${el.tag}}`;
		case 'paragraph': return '{p}';
		case 'button': return '{btn}';
		case 'link': return '{link}';
		case 'input': return '{input}';
		case 'image': {
			const rect = el.element.getBoundingClientRect();
			return `{img ${Math.round(rect.width)}x${Math.round(rect.height)}}`;
		}
		default: return undefined;
	}
}
