/**
 * core/src/types.ts: the contracts every pipeline phase shares.
 *
 * The pipeline threads one mutable `Captured` through capture, resolve, reconcile, minimize,
 * and convert. Defining it here lets each phase know the shape without knowing the others.
 *
 * A feature handler may add a field to `Captured` through module augmentation in a paired
 * `<module>.d.ts`, naming the phase that reads it.
 */

/** The shared object that flows through the whole pipeline. */
export interface Captured {
	// Page metadata
	page: {
		url: string;
		title: string;
		viewport: { width: number; height: number; devicePixelRatio: number };
		userAgent: string;
	};
	capturedAt: string; // Iso 8601

	// Element metadata, also used by assistive mode
	element: {
		tagName: string;
		selector: string; // Shortest unique css selector
		robustSelector: string; // Prefers data-* and stable ids
		xpath: string;
		boundingBox: { x: number; y: number; w: number; h: number };
		innerText: string;
		innerTextSnippet: string; // First 200 chars
		classList: string[];
		id: string | null;
		ancestors: Array<{ tagName: string; selector: string; role?: string }>;
	};

	// Captured pixels
	screenshot: string; // "Data:image/png;base64,..."

	// Dom: only valid during capture + reconcile phases, serialized at html emit
	root: Element; // Original element reference, live dom
	clone: Element; // Detached working copy that bake.ts mutates

	// Css
	stylesheets: Stylesheet[];
	foundationRules: CssRule[]; // Broadly-scoped rules: body, html, *, etc
	componentRules: CssRule[]; // Element-scoped rules
	variables: CssVariable[];
	fonts: FontFace[];
	keyframes: Keyframes[];

	// Accessibility / inaccessibility notes: warnings only, never block
	inaccessible: {
		crossOriginStylesheets: string[]; // Hrefs we couldn't read
		closedShadowRoots: number; // Count of cdp-pierce failures
	};

	// Reconciliation working state: populated by bake.ts, consumed by emit
	bakedStyles: Map<Element, Map<string, string>>;

	// Interactive states measured by forcing them live: capture/states-measure.ts writes,
	// reconcile/features/states.ts reads. Null means measurement did not run, so states.ts
	// copies authored rules instead. An empty array means it ran and found no state effect.
	measuredStates: MeasuredState[] | null;

	// Warnings accumulated across phases: never throw, always append
	warnings: string[];
}

/** One property whose computed value changed under a forced interactive state. */
export interface MeasuredStateDecl {
	/** The longhand or shorthand property name. */
	property: string;
	/** The concrete computed literal read under the forced state, already cascade- and
	 * inheritance-resolved by the engine, so no var()/cascade work remains downstream. */
	value: string;
}

/** One layer of one element the forced state restyled, with the properties that changed. */
export interface MeasuredAffected {
	/** The original live element. Reconcile maps it to its clone via pairedSubtrees. */
	element: Element;
	/** The layer the delta lives on: '' for the element box, '::before'/'::after' for a generated
	 * box whose own computed style changed, such as a glow/underline/reveal a pseudo-element carries. */
	pseudoElement?: string;
	/** The properties whose computed value differs from rest under the forced state. */
	decls: MeasuredStateDecl[];
}

/** One forced activation of a trigger in an interactive state, and everything it restyled. */
export interface MeasuredState {
	/** The original element whose state was forced: the bearer of the dynamic pseudo. */
	trigger: Element;
	/** The dynamic pseudos forced together, colon form, e.g. `[':hover']` or `[':focus-visible']`. */
	states: string[];
	/** The trigger plus any descendant/sibling whose computed value changed under the force. */
	affected: MeasuredAffected[];
}

/** Metadata about one discovered stylesheet, not its rules. Those are flattened into CssRule[]. */
export interface Stylesheet {
	href: string | null;
	origin: 'same-origin' | 'cross-origin' | 'inline' | 'shadow';
	ruleCount: number;
}

/** One style rule flattened out of any sheet, with its grouping context preserved. */
export interface CssRule {
	selector: string;
	properties: Map<string, string>;
	specificity: number; // Standard formula: a*10000 + b*100 + c
	mediaQuery?: string; // Populated if rule lives inside @media
	containerQuery?: string; // Populated if inside @container
	layer?: string; // Populated if inside @layer
	supports?: string; // Populated if inside @supports
	source: 'cssom' | 'cdp' | 'inline' | 'shadow';
}

/** A captured custom property, either already resolved or pending literal resolution. */
export interface CssVariable {
	name: string; // Includes leading "--"
	value: string; // Either resolved or literal-pending
	resolved: boolean;
	scope: 'root' | 'element' | 'shadow-host';
}

/** An @font-face rule, family + src + all descriptors. */
export interface FontFace {
	family: string;
	src: string;
	descriptors: Record<string, string>; // Font-weight, font-style, unicode-range, font-display, etc
}

/** A named @keyframes block, body serialized for re-emission. */
export interface Keyframes {
	name: string;
	rules: string; // Serialized @keyframes body
}

/** The output formats the convert phase can emit. */
export type OutputFormat = 'tailwind' | 'bem-css' | 'jsx-tailwind' | 'vue' | 'html';

/**
 * One file in a split snip result: index.html plus whatever convert/assets.ts lifted out. A
 * text file carries `text`; an image or font carries the original `dataUrl`.
 */
export interface AssetFile {
	name: string; // 'index.html', 'icon-1.svg', 'image-1.png', 'font-1.woff2'
	language: 'html' | 'svg' | 'image' | 'json' | 'font';
	text?: string; // Source for text files
	dataUrl?: string; // Original data: url for binary files (images, fonts)
}
