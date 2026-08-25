/**
 * inspect/schema/types.ts: the page-schema contracts.
 *
 * PageSchema and its sub-types, defined in one place so the extractor, the optimizer, and the
 * renderer agree on one contract instead of three.
 */

/**
 * One color the page uses, with a total usage count and the parts of an element it paints.
 *
 * `contexts` is ranked by weight and trimmed, leaving out a context that accounts for a
 * trivial share of the color's uses. The list then reads as what the color is for rather than
 * everywhere it was seen. `usage` carries the raw per-context counts behind that call.
 */
export interface ColorEntry {
	value: string;
	contexts: string[]; // "text" | "background" | "border", most used first.
	count: number;
	usage?: Record<string, number>;
}

/** One font family, with the sizes and weights it renders in and an inferred usage. */
export interface FontEntry {
	family: string;
	sizes: string[];
	weights: number[];
	usage: string;
}

/** One interactive-state rule lifted from the stylesheets. */
export interface StateRule {
	selector: string;
	state: 'hover' | 'focus' | 'active' | 'focus-visible';
	changes: Record<string, string>;
}

/** The semantic kinds a top-level section is classified into. */
export type SectionType =
	| 'nav' | 'hero' | 'features' | 'how-it-works' | 'testimonials'
	| 'pricing' | 'faq' | 'cta' | 'footer' | 'stats' | 'logos'
	| 'gallery' | 'content' | 'unknown';

/** The layout shapes a section's content can take. */
export type LayoutPattern =
	| 'centered-stack' | 'two-column' | 'two-column-reverse'
	| 'grid-2' | 'grid-3' | 'grid-4' | 'grid-n'
	| 'horizontal-scroll' | 'single-column' | 'split'
	| 'unknown';

/**
 * A section's repeated items, measured rather than named.
 *
 * A label alone is not rebuildable: "logos, horizontal-scroll" gives no count, no item size,
 * and nothing to reproduce, so an agent invents a layout. The count is what the dom holds, with
 * a seamless marquee's duplicated track collapsed to its distinct run.
 */
export interface SectionItems {
	count: number;
	width: number;
	height: number;
	shape: string[]; // One item's make-up in the catalog's vocabulary, e.g. ["icon", "heading", "text"].
}

/** One top-level section's composition: type, layout, and the elements it contains. */
export interface SectionBlueprint {
	type: SectionType;
	tag: string;
	layout: LayoutPattern;
	/**
	 * False when the layout could not be measured from the rendered boxes. The layout is then
	 * 'unknown' and must be reported as unknown, never as a default: under a hard contract a
	 * silent fallback is worse than an honest gap.
	 */
	layoutMeasured: boolean;
	alignment: 'left' | 'center' | 'right';
	background: string; // Bg color or "transparent".
	elements: string[]; // Ordered, e.g. ["badge", "heading", "subtext", "button-pair", "image"].
	items?: SectionItems; // Set only when the section repeats: a grid, a scroll track, a row cluster.
	gridColumns?: number;
	columnRatio?: string; // Width split of a two-column row, e.g. "58/42".
	maxWidth?: string;
	gap?: string;
	padding?: string;
}

/** A recurring element grouping across sections, e.g. "heading+text+cta". */
export interface ContentGrouping {
	pattern: string;
	occurrences: number;
	elements: string[];
}

/** One button variant's full visual spec, including hover/active states. */
export interface ButtonBlueprint {
	variant: string; // "primary", "secondary", "ghost", etc.
	bg: string;
	color: string;
	borderRadius: string;
	padding: string;
	fontWeight: number;
	fontSize: string;
	border: string;
	shadow: string;
	hover: Record<string, string>;
	active: Record<string, string>;
	styleTag: string; // "flat", "pressed-3d", "gradient", "outline", "ghost", "elevated".
}

/** One card variant's visual spec plus its inner layout. */
export interface CardBlueprint {
	bg: string;
	borderRadius: string;
	shadow: string;
	border: string;
	padding: string;
	hover: Record<string, string>;
	innerLayout: string; // E.g. "image + heading + text + button".
}

/** The page navigation's spec. */
export interface NavBlueprint {
	tag: string; // The bar's element, e.g. "header"; an inner "nav" means no bar was found.
	bg: string;
	position: string;
	height: string;
	blur: boolean; // Has backdrop-filter blur.
	border: string;
	layout: string; // E.g. "logo-left + links-center + cta-right".
	linkCount: number;
}

/**
 * One background effect and the section it was seen in.
 *
 * The location is the point. An effect asserted of the whole page is true and useless as a
 * constraint. With nowhere attached, an agent reads it as permission to paint the effect
 * wherever convention suggests. A rebuild put two gradients into a hero the schema measured as
 * flat. `section` indexes the schema's own sections list, and is absent when the
 * effect sits outside every section.
 */
export interface BackgroundEffect {
	effect: string; // "gradient", "backdrop-blur", or "blur-blobs".
	section?: number;
}

/** The page's decorative language: blobs, located effects, illustration mix, accents. */
export interface DecorativeInfo {
	hasBlobs: boolean;
	illustrationStyle: string; // "none", "icon-based", "photo", "mixed".
	backgroundEffects: BackgroundEffect[];
	accentTreatments: string[];
}

/**
 * The page's responsive behavior, read from media queries.
 *
 * Both behaviors report "unknown" when no rule provides evidence, exactly as an unmeasurable
 * layout does. A default here reads as a measurement and is not one.
 */
export interface ResponsiveInfo {
	breakpoints: string[];
	mobileNavStyle: string; // "hamburger" or "unknown".
	gridCollapseBehavior: string; // "stack", "scroll", "reduce-columns", or "unknown".
}

/** The complete compressed design-system schema for one page. */
export interface PageSchema {
	meta: {
		url: string;
		title: string;
		viewport: { w: number; h: number };
	};
	tokens: {
		colors: ColorEntry[];
		fonts: FontEntry[];
		spacing: string[];
		radii: string[];
		shadows: string[];
		scaleAnalysis?: { ratio: number; name: string; base: number; deviation: number };
	};
	states: StateRule[];
	sections: SectionBlueprint[];
	contentPatterns: ContentGrouping[];
	buttons: ButtonBlueprint[];
	cards: CardBlueprint[];
	nav: NavBlueprint | null;
	decorative: DecorativeInfo;
	responsive: ResponsiveInfo;
}
