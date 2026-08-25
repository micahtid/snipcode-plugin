/**
 * reconcile/denoise.ts: dropping the declarations that restate a default.
 *
 * Runs in reconcile, after the feature handlers and before convert, so every output format
 * ships the smaller result. Baking every winning property leaves declarations that repeat a
 * ua default, repeat an inherited value, or do nothing here, such as transform-origin with
 * no transform.
 *
 * Each drop is measured, never guessed. The baselines come from a probe element in a clean
 * iframe, off-screen but laid out. display:none or a detached node returns empty or
 * blockified values instead.
 *
 * Two more drops ride the same machinery. A css-wide keyword resolves to the value it produces
 * before being matched. And a legacy prefixed flexbox longhand goes when its standard
 * counterpart is present and the old box model is not in use.
 */
import type { Captured } from '../types';
import { pairedSubtrees, isRedundantDecl, transformContext, inheritsProperty } from './match';
import { withProbeFrame } from './frame';

/**
 * Drops every baked declaration that renders identically when removed.
 *
 * @param captured - bakedStyles + clone are mutated in place
 */
export function denoise(captured: Captured): void {
	try {
		const pairs = pairedSubtrees(captured.root, captured.clone);
		withProbeFrame((doc, win) => {
			const defaultsFor = elementDefaultProbe(doc, win);
			for (let i = 0; i < pairs.length; i++) {
				const pair = pairs[i];
				if (!pair) continue;
				const [original, clone] = pair;
				const baked = captured.bakedStyles.get(clone);
				if (!baked || baked.size === 0) continue;

				const isRoot = i === 0;
				const defaults = defaultsFor(original);
				const box = transformContext(getComputedStyle(original));

				for (const [prop, value] of Array.from(baked)) {
					// The snip root loses its ancestor chain, so an inherited value baked onto
					// it has no parent to fall back to and must stay. Non-inherited values on
					// the root still de-noise, since their default needs no parent.
					if (isRoot && inheritsProperty(prop)) continue;
					if (isDroppableDecl(captured, clone, prop, value, defaults, box)) dropDecl(baked, clone, prop);
				}
				dropDeadPrefixes(captured, baked, clone);
				if (baked.size === 0) captured.bakedStyles.delete(clone);
			}
		});
	} catch (err) {
		captured.warnings.push(`denoise: skipped (${(err as Error).message})`);
	}
}

/** Removes one declaration from the baked map and the clone's inline style. */
function dropDecl(baked: Map<string, string>, clone: Element, prop: string): void {
	baked.delete(prop);
	try {
		(clone as HTMLElement).style.removeProperty(prop);
	} catch {
		// Not removable for this element, so the baked-map delete is enough.
	}
}

/**
 * Whether one baked declaration renders identically when dropped, with every fallback
 * baseline filled in from the snip rather than the live page.
 *
 * A css-wide keyword is resolved to the value it produces first, so a keyword-form default
 * sheds the way a literal one does. The element pass and the pseudo pass ask this same
 * question of the same inputs, so they ask it here.
 *
 * @param defaults - the baseline a non-inherited value falls back to, per property
 * @param box - whether the element establishes a transform or a perspective
 */
export function isDroppableDecl(
	captured: Captured,
	clone: Element,
	prop: string,
	value: string,
	defaults: Map<string, string>,
	box: { hasTransform: boolean; hasPerspective: boolean },
): boolean {
	const inherits = inheritsProperty(prop);
	const resolved = resolveCssWideKeyword(captured, clone, prop, value) ?? value;
	return isRedundantDecl(prop, resolved, {
		defaultValue: defaults.get(prop),
		inheritedValue: inherits ? effectiveInherited(captured, clone, prop) : undefined,
		inherits,
		hasTransform: box.hasTransform,
		hasPerspective: box.hasPerspective,
	});
}

/**
 * Resolves a css-wide keyword to the value it produces, so the exact-string redundancy test
 * can match it. bake.ts ships these keywords verbatim, and `initial` never string-matches a
 * resolved default like `rgb(0, 0, 0)`.
 *
 * `initial` comes from the all:initial probe, which is the spec initial rather than the ua
 * default; the two differ for display among others. `inherit` resolves only on a property
 * that truly inherits. On a non-inherited one, the `* { box-sizing: inherit }` idiom being the
 * common case, it pulls the parent's used value, which the baked chain does not carry. So it
 * is left alone rather than mis-resolved and wrongly dropped. `unset` is safe either
 * way: the spec makes it the inherited value or the initial, never the parent's used value.
 * `revert` is left alone, since it reverts to an origin the standalone snip does not carry.
 *
 * @returns the resolved value, or undefined to leave the value untouched
 */
export function resolveCssWideKeyword(captured: Captured, clone: Element, prop: string, value: string): string | undefined {
	switch (value.trim()) {
		case 'initial':
			return initialStyles().get(prop);
		case 'inherit':
			return inheritsProperty(prop) ? effectiveInherited(captured, clone, prop) : undefined;
		case 'unset':
			return inheritsProperty(prop) ? effectiveInherited(captured, clone, prop) : initialStyles().get(prop);
		default:
			return undefined;
	}
}

/**
 * Drops a legacy prefixed flexbox longhand when its standard counterpart sits beside it and
 * the old display model is not active. With both conditions met, every engine ignores the
 * prefixed form, so removing it is a provable no-op. With no standard sibling it stays,
 * because there it may still do the work.
 *
 * The display guard matters. Under `display: -webkit-box`, `-webkit-box-orient: vertical`
 * and the `-webkit-line-clamp` idiom still drive layout even with a standard property
 * present. The guard reads the BAKED display, not the live one: the output renders with the
 * baked value, and live getComputedStyle reports `flow-root` for a line-clamped box anyway.
 * Old box props are honored on the element itself or on a child of one, so both the element's
 * baked display and its parent's are checked. The `-webkit-flex-*` aliases need no guard.
 */
function dropDeadPrefixes(captured: Captured, baked: Map<string, string>, clone: Element): void {
	const selfOldBox = isOldBox(baked.get('display'));
	let parentOldBox: boolean | undefined;
	for (const [prefixed, standard, scope] of PREFIXED_FLEX_PAIRS) {
		if (!baked.has(prefixed) || !baked.has(standard)) continue;
		if (scope === 'box-self' && selfOldBox) continue;
		if (scope === 'box-item') {
			// Resolved lazily, since most elements carry no old box item property at all.
			if (parentOldBox === undefined) {
				const parent = clone.parentElement;
				parentOldBox = isOldBox(parent ? captured.bakedStyles.get(parent)?.get('display') : undefined);
			}
			if (parentOldBox) continue;
		}
		dropDecl(baked, clone, prefixed);
	}
}

/** Whether a baked display uses the legacy 2009 flexbox (`-webkit-box`) model. */
function isOldBox(display: string | undefined): boolean {
	return display === '-webkit-box' || display === '-webkit-inline-box';
}

/**
 * The value `prop` actually inherits in the standalone snip: the nearest clone ancestor that
 * bakes it, or the css initial.
 *
 * Read from the baked clone chain, never the live page. A value the live ancestor only
 * inherits from the page, a global body font say, does not travel with the snip. Comparing
 * against the live parent would drop a declaration the snip still needs.
 *
 * @returns the inherited value, or undefined if not even an initial exists
 */
export function effectiveInherited(captured: Captured, clone: Element, prop: string): string | undefined {
	let node = clone.parentElement;
	while (node) {
		const value = captured.bakedStyles.get(node)?.get(prop);
		if (value !== undefined) return value;
		node = node.parentElement;
	}
	return initialStyles().get(prop);
}

/**
 * Builds a probe returning an element's ua default computed style, from a shallow copy of the
 * element laid out alone in the hidden iframe. Cached per attribute signature.
 *
 * The copy keeps the attributes because the default depends on them, not only on the tag.
 * `a[href]` is underlined where a bare `a` is not, and a checkbox differs from a text input.
 * The iframe strips the page's author rules, which do not travel with the snip.
 *
 * @returns a function from a live element to its longhand prop->default-value map
 */
function elementDefaultProbe(doc: Document, win: Window): (el: Element) => Map<string, string> {
	const cache = new Map<string, Map<string, string>>();
	return (el: Element): Map<string, string> => {
		const key = probeKey(el);
		let defaults = cache.get(key);
		if (!defaults) {
			const probe = doc.importNode(el, false) as Element;
			probe.removeAttribute('style');
			doc.body.appendChild(probe);
			defaults = snapshotLonghands(win.getComputedStyle(probe));
			probe.remove();
			cache.set(key, defaults);
		}
		return defaults;
	};
}

/**
 * A cache key over the attributes that affect ua styling. Excludes style, the thing under
 * test, plus id, class, and the data- and aria- families, which no ua rule matches and which
 * would only fragment the cache.
 */
function probeKey(el: Element): string {
	const parts = [el.tagName.toLowerCase()];
	for (const attr of Array.from(el.attributes)) {
		const name = attr.name;
		if (name === 'style' || name === 'id' || name === 'class') continue;
		if (name.startsWith('data-') || name.startsWith('aria-')) continue;
		parts.push(`${name}=${attr.value}`);
	}
	return parts.join('|');
}

/**
 * The ua default computed style for a pseudo on a given element, such as ::placeholder's grey
 * or ::marker's disc. Same probe as elementDefaultProbe, read at `pseudo`, so the pseudo
 * handler de-noises against the ground truth the element pass uses. Cached per signature.
 *
 * @returns a longhand prop->default-value map for that pseudo
 */
export function pseudoDefaults(el: Element, pseudo: string): Map<string, string> {
	const key = `${probeKey(el)}${pseudo}`;
	const cached = PSEUDO_DEFAULT_CACHE.get(key);
	if (cached) return cached;
	let defaults = new Map<string, string>();
	withProbeFrame((doc, win) => {
		const probe = doc.importNode(el, false) as Element;
		probe.removeAttribute('style');
		doc.body.appendChild(probe);
		defaults = snapshotLonghands(win.getComputedStyle(probe, pseudo));
		probe.remove();
	});
	PSEUDO_DEFAULT_CACHE.set(key, defaults);
	return defaults;
}

/**
 * The css initial value of every longhand, from one all:initial probe. Cached, since initials
 * are constant. This is the last-resort fallback when no clone ancestor bakes a property.
 */
function initialStyles(): Map<string, string> {
	if (!INITIAL_CACHE) {
		withProbeFrame((doc, win) => {
			const probe = doc.createElement('div');
			probe.style.cssText = 'all:initial';
			doc.body.appendChild(probe);
			INITIAL_CACHE = snapshotLonghands(win.getComputedStyle(probe));
			probe.remove();
		});
	}
	return INITIAL_CACHE ?? new Map<string, string>();
}

/** Snapshot every enumerable longhand from a computed style into a plain map. */
function snapshotLonghands(cs: CSSStyleDeclaration): Map<string, string> {
	const map = new Map<string, string>();
	for (let i = 0; i < cs.length; i++) {
		const prop = cs.item(i);
		if (prop) map.set(prop, cs.getPropertyValue(prop));
	}
	return map;
}

let INITIAL_CACHE: Map<string, string> | null = null;
const PSEUDO_DEFAULT_CACHE = new Map<string, Map<string, string>>();

/**
 * Where a prefixed flexbox property is honored, which decides its display guard. `box-self` is
 * a 2009 box property honored on its own `-webkit-box` element, and `box-item` is one honored
 * on a child of one. `alias` is a 2011 name modern engines treat as a plain alias of the
 * standard property, so it needs no guard.
 */
type PrefixScope = 'box-self' | 'box-item' | 'alias';

/**
 * Legacy prefixed flexbox longhands, each with the standard property that supersedes it and
 * its guard scope. See dropDeadPrefixes: the gate is the standard sibling plus the display
 * guard, never a value match.
 */
const PREFIXED_FLEX_PAIRS: Array<[string, string, PrefixScope]> = [
	['-webkit-box-align', 'align-items', 'box-self'],
	['-webkit-box-pack', 'justify-content', 'box-self'],
	['-webkit-box-orient', 'flex-direction', 'box-self'],
	['-webkit-box-direction', 'flex-direction', 'box-self'],
	['-webkit-box-flex', 'flex-grow', 'box-item'],
	['-webkit-box-ordinal-group', 'order', 'box-item'],
	['-webkit-flex-direction', 'flex-direction', 'alias'],
	['-webkit-flex-wrap', 'flex-wrap', 'alias'],
	['-webkit-flex-flow', 'flex-flow', 'alias'],
	['-webkit-flex-grow', 'flex-grow', 'alias'],
	['-webkit-flex-shrink', 'flex-shrink', 'alias'],
	['-webkit-flex-basis', 'flex-basis', 'alias'],
	['-webkit-justify-content', 'justify-content', 'alias'],
	['-webkit-align-items', 'align-items', 'alias'],
	['-webkit-align-self', 'align-self', 'alias'],
	['-webkit-align-content', 'align-content', 'alias'],
	['-webkit-order', 'order', 'alias'],
];
