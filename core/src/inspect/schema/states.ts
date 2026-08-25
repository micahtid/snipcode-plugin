/**
 * inspect/schema/states.ts: the interactive-state rules.
 *
 * Runs during the page-scoped inspect pass; see extract.ts for the order of operations.
 * Lifts the hover, focus, and active rules that target walked elements, which is what a
 * redesign needs to reproduce the page's interactive feel. Resting styles cannot show it.
 */
import type { WalkedElement } from './shared';
import type { StateRule } from './types';

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

		// Drop the css escapes before matching. A utility class named "hover:bg-x" is written
		// `.hover\:bg-x` in the sheet but reads back unescaped off the element. A raw
		// comparison matched nothing at all on a utility-class page.
		const baseSelector = selector.replace(/:(?:hover|focus|active|focus-visible)/g, '').replace(/\\/g, '').trim();
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
