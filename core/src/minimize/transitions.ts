/**
 * minimize/transitions.ts: dropping transition layers that can never move.
 *
 * Runs in minimize, after normalize and before merge and the at-rule purge. A utility class
 * bakes a long enumerated transition-property list onto the resting rule, and nothing changes
 * most of those properties. This drops every layer nothing changes, and when the survivors
 * share one timing it emits the grouped form rather than repeating the timing per layer.
 *
 * The order matters: dropping a --tw-gradient-* layer removes that name's last transition
 * mention, which lets the purge retire its @property registration.
 *
 * Liveness is by construction, not oracle-gated. A transition paints no resting pixel, yet
 * getComputedStyle enumerates transition-property, so the oracle would read a dropped layer as
 * a change. A layer for a property nothing changes is unobservable, and the grouped form
 * cycles one timing across the list, which is the engine's own rule.
 */
import { serializeRules, WITHHELD } from './declarations';
import { splitTopLevelCommas, TIMING_LONGHANDS } from '../resolve/transition';
import { parseCss } from '../utils/css-rules';

/** The default each timing sub-list takes for a layer past its length, its css initial value. */
const TIMING_DEFAULTS = ['0s', 'ease', '0s', 'normal'] as const;

/** One transition layer: the property it animates and the timing it animates over. */
interface Layer {
	property: string;
	duration: string;
	easing: string;
	delay: string;
	behavior: string;
}

/**
 * Drops every transition layer whose property no state rule or animation changes, and groups a
 * surviving list that shares one timing. Graceful by contract: css that will not parse, or
 * holds no transition, comes back unchanged. A pure function of the input text.
 *
 * @returns the stylesheet with dead transition layers dropped and shared timing grouped
 */
export function foldTransitions(css: string): string {
	if (!css.trim() || !/transition/.test(css)) return css;
	const sheet = parseCss(css);
	if (!sheet) return css;
	const rules = Array.from(sheet.cssRules);
	const changed = changedLonghands(rules);
	const reads = customPropertyReads(css);
	const scratch = document.createElement('span').style;
	foldRules(rules, changed, reads, scratch);
	return serializeRules(rules);
}

/** Recursively folds every style rule's transition, descending into @media/@supports/@layer. */
function foldRules(rules: CSSRule[], changed: Set<string>, reads: Set<string>, scratch: CSSStyleDeclaration): void {
	for (const rule of rules) {
		if (rule.type === CSSRule.STYLE_RULE) foldRuleTransition(rule as CSSStyleRule, changed, reads, scratch);
		else if ('cssRules' in rule && rule.type !== CSSRule.KEYFRAMES_RULE) foldRules(Array.from((rule as CSSGroupingRule).cssRules), changed, reads, scratch);
	}
}

/**
 * Every longhand a withheld rule or a @keyframes changes. A transition layer expanding to one
 * of these can produce motion; one expanding to none cannot. The cssom stores declarations as
 * expanded longhands, so a state rule's `background` contributes `background-color` and the
 * rest, matching that transition layer correctly.
 */
function changedLonghands(rules: CSSRule[]): Set<string> {
	const changed = new Set<string>();
	const visit = (list: CSSRule[]): void => {
		for (const rule of list) {
			if (rule.type === CSSRule.STYLE_RULE) {
				const styleRule = rule as CSSStyleRule;
				if (WITHHELD.test(styleRule.selectorText || '')) addLonghands(styleRule.style, changed);
			} else if (rule.type === CSSRule.KEYFRAMES_RULE) {
				for (const frame of Array.from((rule as CSSKeyframesRule).cssRules)) addLonghands((frame as CSSKeyframeRule).style, changed);
			} else if ('cssRules' in rule) {
				visit(Array.from((rule as CSSGroupingRule).cssRules));
			}
		}
	};
	visit(rules);
	return changed;
}

/** Adds every property a declaration block sets, lowercased, to `into`. */
function addLonghands(style: CSSStyleDeclaration, into: Set<string>): void {
	for (let i = 0; i < style.length; i++) into.add(style.item(i).toLowerCase());
}

/** The custom-property names read through a `var()` anywhere in the sheet. */
function customPropertyReads(css: string): Set<string> {
	const reads = new Set<string>();
	for (const m of css.matchAll(/var\(\s*(--[\w-]+)/g)) reads.add(m[1]!);
	return reads;
}

/**
 * Folds one rule's transition in place. Read the cssom longhands, cycle the timing sub-lists
 * out to the property-list length, then drop the layers no state changes. The rewrite happens
 * only when a layer went or the grouped form is shorter, so a minimal rule keeps its text.
 */
function foldRuleTransition(rule: CSSStyleRule, changed: Set<string>, reads: Set<string>, scratch: CSSStyleDeclaration): void {
	const style = rule.style;
	const properties = splitTopLevelCommas(style.getPropertyValue('transition-property'));
	if (properties.length === 0) return; // No transition on this rule.
	const priority = style.getPropertyPriority('transition-property');
	const timings = TIMING_LONGHANDS.map((longhand) => splitTopLevelCommas(style.getPropertyValue(longhand)));
	const layers: Layer[] = properties.map((property, i) => ({
		property: property.trim(),
		duration: cycle(timings[0]!, i, TIMING_DEFAULTS[0]),
		easing: cycle(timings[1]!, i, TIMING_DEFAULTS[1]),
		delay: cycle(timings[2]!, i, TIMING_DEFAULTS[2]),
		behavior: cycle(timings[3]!, i, TIMING_DEFAULTS[3]),
	}));

	const kept = layers.filter((layer) => producesMotion(layer.property, changed, reads, scratch));
	const dropped = kept.length < layers.length;
	const shareable = kept.length >= 2 && kept.every((layer) => sameTiming(layer, kept[0]!));
	// Otherwise leave the rule's transition exactly as it was.
	if (!dropped && !(shareable && groupedText(kept, priority).length < currentText(style).length)) return;

	clearTransition(style);
	if (kept.length === 0) return; // Every layer was dead, so the rule animates nothing.
	if (shareable) applyGrouped(style, kept, priority);
	else applyList(style, kept, priority);
}

/** The value at `i` in a cycled sub-list, or the property's initial value when the list is empty. */
function cycle(values: string[], i: number, fallback: string): string {
	return values.length === 0 ? fallback : values[i % values.length]!.trim();
}

/** Whether two layers share the same duration, easing, delay, and behavior. */
function sameTiming(a: Layer, b: Layer): boolean {
	return a.duration === b.duration && a.easing === b.easing && a.delay === b.delay && a.behavior === b.behavior;
}

/**
 * Whether a transition layer can produce motion: some state rule or animation changes the
 * property, or a longhand it expands to. A custom property must also be read through a var(),
 * since a value nothing paints from animates nothing. `all` and `none` are always kept.
 */
function producesMotion(property: string, changed: Set<string>, reads: Set<string>, scratch: CSSStyleDeclaration): boolean {
	const name = property.toLowerCase();
	if (name === 'all' || name === 'none') return true;
	if (name.startsWith('--')) return changed.has(name) && reads.has(property);
	if (changed.has(name)) return true;
	for (const longhand of expandToLonghands(scratch, property)) if (changed.has(longhand)) return true;
	return false;
}

/**
 * The longhands a property expands to. Setting it to `inherit`, valid for every property,
 * makes the cssom store a shorthand as its longhands and a longhand as itself. `background`
 * then yields `background-color` and the rest, while an unknown property stores nothing.
 */
function expandToLonghands(scratch: CSSStyleDeclaration, property: string): string[] {
	scratch.cssText = '';
	try {
		scratch.setProperty(property, 'inherit');
	} catch {
		return [];
	}
	const longhands: string[] = [];
	for (let i = 0; i < scratch.length; i++) longhands.push(scratch.item(i).toLowerCase());
	return longhands;
}

/** Removes every transition property from a declaration block, shorthand and longhands alike. */
function clearTransition(style: CSSStyleDeclaration): void {
	style.removeProperty('transition');
	style.removeProperty('transition-property');
	for (const longhand of TIMING_LONGHANDS) style.removeProperty(longhand);
}

/**
 * Sets the grouped form: the property list against one duration and easing, plus delay and
 * behavior where they are not the default. The single timing values cycle across the list, and
 * the cssom keeps them as longhands, which is the compact form a human writes.
 */
function applyGrouped(style: CSSStyleDeclaration, layers: Layer[], priority: string): void {
	const first = layers[0]!;
	style.setProperty('transition-property', layers.map((l) => l.property).join(', '), priority);
	style.setProperty('transition-duration', first.duration, priority);
	style.setProperty('transition-timing-function', first.easing, priority);
	if (first.delay !== TIMING_DEFAULTS[2]) style.setProperty('transition-delay', first.delay, priority);
	if (first.behavior !== TIMING_DEFAULTS[3]) style.setProperty('transition-behavior', first.behavior, priority);
}

/**
 * Sets the `transition` shorthand as a per-layer list, each spelling out property, duration,
 * easing, and a non-default delay. A non-default behavior rides on the longhand list alongside,
 * since engines do not reliably carry it in the shorthand.
 */
function applyList(style: CSSStyleDeclaration, layers: Layer[], priority: string): void {
	const list = layers.map((layer) => {
		const parts = [layer.property, layer.duration, layer.easing];
		if (layer.delay !== TIMING_DEFAULTS[2]) parts.push(layer.delay);
		return parts.join(' ');
	});
	style.setProperty('transition', list.join(', '), priority);
	if (layers.some((layer) => layer.behavior !== TIMING_DEFAULTS[3])) {
		style.setProperty('transition-behavior', layers.map((l) => l.behavior).join(', '), priority);
	}
}

/** The grouped serialization's length, for the shorter-than-current comparison. */
function groupedText(layers: Layer[], priority: string): string {
	const bang = priority ? ' !important' : '';
	const first = layers[0]!;
	let text = `transition-property: ${layers.map((l) => l.property).join(', ')}${bang}; transition-duration: ${first.duration}${bang}; transition-timing-function: ${first.easing}${bang}`;
	if (first.delay !== TIMING_DEFAULTS[2]) text += `; transition-delay: ${first.delay}${bang}`;
	if (first.behavior !== TIMING_DEFAULTS[3]) text += `; transition-behavior: ${first.behavior}${bang}`;
	return text;
}

/** The rule's current transition serialization, for the shorter-than-current comparison. */
function currentText(style: CSSStyleDeclaration): string {
	const shorthand = style.getPropertyValue('transition');
	if (shorthand) return `transition: ${shorthand}`;
	return ['transition-property', ...TIMING_LONGHANDS]
		.map((longhand) => (style.getPropertyValue(longhand) ? `${longhand}: ${style.getPropertyValue(longhand)}` : ''))
		.filter(Boolean)
		.join('; ');
}
