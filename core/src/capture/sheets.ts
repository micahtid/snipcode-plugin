/**
 * capture/sheets.ts: every rule on the page, flattened.
 *
 * Runs during capture, over document.styleSheets. A snipped element's appearance comes from
 * rules scattered across every sheet. All of them collapse into one CssRule list that keeps
 * each rule's grouping context for later phases to judge. The broadly scoped foundation rules
 * split from the element-scoped ones, and a cross-origin sheet that throws on .cssRules is
 * recorded here and recovered in cdp.ts.
 */
import type { CssRule, CssVariable, FontFace, Keyframes, Stylesheet } from '../types';
import { holdsChildRules } from '../utils/css-rules';
import { absolutizeUrls } from '../utils/css-urls';

/** Everything sheets discovery contributes to Captured, returned for the orchestrator to assign. */
export interface SheetDiscovery {
	stylesheets: Stylesheet[];
	foundationRules: CssRule[];
	componentRules: CssRule[];
	variables: CssVariable[];
	fonts: FontFace[];
	keyframes: Keyframes[];
	crossOriginStylesheets: string[];
}

/** Grouping context threaded down through nested @media/@supports/@layer/@container. */
interface RuleContext {
	mediaQuery?: string;
	supports?: string;
	layer?: string;
	containerQuery?: string;
}

/**
 * Walks every accessible stylesheet and flattens it. A cross-origin sheet raises on .cssRules,
 * and its href is recorded for a later background fetch rather than failing the walk.
 */
export function discoverStylesheets(): SheetDiscovery {
	const out: SheetDiscovery = {
		stylesheets: [],
		foundationRules: [],
		componentRules: [],
		variables: [],
		fonts: [],
		keyframes: [],
		crossOriginStylesheets: [],
	};

	for (const sheet of Array.from(document.styleSheets)) {
		const origin = sheetOrigin(sheet);
		let rules: CSSRuleList | null = null;
		try {
			rules = sheet.cssRules; // Throws SecurityError on cross-origin
		} catch {
			// Unreadable from the content script, so capture/cdp.ts recovers it by href.
			if (sheet.href) out.crossOriginStylesheets.push(sheet.href);
			out.stylesheets.push({ href: sheet.href, origin: 'cross-origin', ruleCount: 0 });
			continue;
		}
		const before = out.foundationRules.length + out.componentRules.length;
		const fontsBefore = out.fonts.length;
		walkRules(rules, {}, out, 'cssom');
		// A @font-face src is relative to its own stylesheet, not the page, so this sheet's
		// faces absolutize against the sheet url. Otherwise a sheet served from a sub-path,
		// the next.js /_next/static/css shape, resolves against the page root and 404s.
		absolutizeFontSrcs(out.fonts, fontsBefore, sheet.href || document.baseURI);
		const after = out.foundationRules.length + out.componentRules.length;
		out.stylesheets.push({ href: sheet.href, origin, ruleCount: after - before });
	}

	return out;
}

/**
 * Parses raw css into the same discovery shape, for a cross-origin sheet recovered through the
 * Host. A constructable stylesheet keeps the parse off the live page. The rules carry the
 * caller's `source` tag, so later phases can tell a recovered rule from a cssom-read one.
 */
export async function parseCssText(cssText: string, source: CssRule['source'] = 'cssom', base?: string): Promise<SheetDiscovery> {
	const out: SheetDiscovery = {
		stylesheets: [],
		foundationRules: [],
		componentRules: [],
		variables: [],
		fonts: [],
		keyframes: [],
		crossOriginStylesheets: [],
	};
	const sheet = new CSSStyleSheet();
	await sheet.replace(cssText);
	walkRules(sheet.cssRules, {}, out, source);
	if (base) absolutizeFontSrcs(out.fonts, 0, base);
	return out;
}

/**
 * Rewrites the src of every face from index `start` onward to an absolute url against
 * `base`, the owning stylesheet's url. Idempotent, because absolutizeUrls leaves an
 * already-resolved target alone and never matches a local() source.
 *
 * @param fonts - the discovered faces, mutated in place from `start`
 */
function absolutizeFontSrcs(fonts: FontFace[], start: number, base: string): void {
	for (let i = start; i < fonts.length; i++) {
		const font = fonts[i];
		if (font) font.src = absolutizeUrls(font.src, base);
	}
}

/** Classify a sheet's origin from its owner node and href. */
function sheetOrigin(sheet: CSSStyleSheet): Stylesheet['origin'] {
	if (sheet.ownerNode instanceof HTMLStyleElement) return 'inline';
	if (!sheet.href) return 'inline';
	try {
		return new URL(sheet.href, location.href).origin === location.origin ? 'same-origin' : 'cross-origin';
	} catch {
		return 'same-origin';
	}
}

/**
 * Flattens a rule list, threading grouping context into nested blocks. Style rules become
 * CssRule entries, @font-face and @keyframes lift into their own collections, and custom
 * properties are harvested as CssVariable definitions.
 */
function walkRules(rules: CSSRuleList, ctx: RuleContext, out: SheetDiscovery, source: CssRule['source']): void {
	for (const rule of Array.from(rules)) {
		if (rule instanceof CSSStyleRule) {
			collectStyleRule(rule, ctx, out, source);
		} else if (rule instanceof CSSMediaRule) {
			walkRules(rule.cssRules, { ...ctx, mediaQuery: rule.conditionText }, out, source);
		} else if (rule instanceof CSSSupportsRule) {
			walkRules(rule.cssRules, { ...ctx, supports: rule.conditionText }, out, source);
		} else if (rule instanceof CSSFontFaceRule) {
			collectFontFace(rule, out);
		} else if (rule instanceof CSSKeyframesRule) {
			out.keyframes.push({
				name: rule.name,
				rules: Array.from(rule.cssRules)
					.map((r) => r.cssText)
					.join('\n'),
			});
		} else if (holdsChildRules(rule)) {
			// @layer and @container are recent enough that the dom lib may not declare them,
			// so they are detected structurally. The layers and units handlers refine this
			// later; here the context is only preserved.
			const layer = readField(rule, 'name');
			const containerQuery = readField(rule, 'conditionText');
			walkRules(rule.cssRules, {
				...ctx,
				...(layer ? { layer } : {}),
				...(containerQuery ? { containerQuery } : {}),
			}, out, source);
		}
		// CSSImportRule and the rest are ignored: @import resolves at fetch time.
	}
}

/** Turn a CSSStyleRule into a CssRule, harvesting any custom-property defs. */
function collectStyleRule(rule: CSSStyleRule, ctx: RuleContext, out: SheetDiscovery, source: CssRule['source']): void {
	const properties = new Map<string, string>();
	const style = rule.style;
	for (let i = 0; i < style.length; i++) {
		const prop = style.item(i);
		if (!prop) continue;
		const value = style.getPropertyValue(prop).trim();
		properties.set(prop, value);
		if (prop.startsWith('--')) {
			out.variables.push({
				name: prop,
				value,
				resolved: false, // resolved later (resolve/vars.ts)
				scope: isRootScope(rule.selectorText) ? 'root' : 'element',
			});
		}
	}
	const entry: CssRule = {
		selector: rule.selectorText,
		properties,
		specificity: specificityOf(rule.selectorText),
		source,
		...(ctx.mediaQuery ? { mediaQuery: ctx.mediaQuery } : {}),
		...(ctx.containerQuery ? { containerQuery: ctx.containerQuery } : {}),
		...(ctx.layer ? { layer: ctx.layer } : {}),
		...(ctx.supports ? { supports: ctx.supports } : {}),
	};
	if (isFoundationSelector(rule.selectorText)) out.foundationRules.push(entry);
	else out.componentRules.push(entry);
}

/** Lift an @font-face into a FontFace record with all descriptors. */
function collectFontFace(rule: CSSFontFaceRule, out: SheetDiscovery): void {
	const style = rule.style;
	const descriptors: Record<string, string> = {};
	let family = '';
	let src = '';
	for (let i = 0; i < style.length; i++) {
		const prop = style.item(i);
		if (!prop) continue;
		const value = style.getPropertyValue(prop).trim();
		if (prop === 'font-family') family = value.replace(/^['"]|['"]$/g, '');
		else if (prop === 'src') src = value;
		else descriptors[prop] = value;
	}
	out.fonts.push({ family, src, descriptors });
}

/** Broadly-scoped selectors (html/body/:root/*) seed the foundation layer. */
function isFoundationSelector(selector: string): boolean {
	return selector
		.split(',')
		.some((s) => /^\s*(\*|:root|html|body)\b/.test(s.trim()) || s.trim() === '*');
}

/** :root / html selectors define document-level custom properties. */
function isRootScope(selector: string): boolean {
	return /(^|,)\s*(:root|html)\s*(,|$)/.test(selector);
}

/** Read an optional string field off a rule object, '' if absent. */
function readField(rule: CSSRule, field: string): string {
	const value = (rule as unknown as Record<string, unknown>)[field];
	return typeof value === 'string' ? value : '';
}

/**
 * Selector specificity as a*10000 + b*100 + c: ids, then classes and attributes and
 * pseudo-classes, then elements and pseudo-elements. The classic three-tuple flattened to one
 * number, which is enough for cascade ordering in reconcile.
 */
export function specificityOf(selector: string): number {
	// Score the most specific comma-branch, matching querySelector semantics.
	let best = 0;
	for (const branch of selector.split(',')) {
		const s = branch.trim();
		const ids = (s.match(/#[\w-]+/g) ?? []).length;
		const classesAttrsPseudo =
			(s.match(/\.[\w-]+/g) ?? []).length +
			(s.match(/\[[^\]]+\]/g) ?? []).length +
			(s.match(/(?<!:):(?!:)[\w-]+/g) ?? []).length;
		const elementsPseudoEl =
			(s.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length + (s.match(/::[\w-]+/g) ?? []).length;
		best = Math.max(best, ids * 10000 + classesAttrsPseudo * 100 + elementsPseudoEl);
	}
	return best;
}
