/**
 * inspect/schema/classify.ts: semantic element classifier
 *
 * Pipeline position: inspect, page-scoped. It reads the live dom directly and does not run the element pipeline.
 * Reads from DOM: document/window. This runs live, on per-element computed styles.
 * Writes to: nothing. This is pure classification.
 *
 * Principles applied: none. This is classification.
 *
 * Why this exists: the schema walk needs each element's semantic role, such as
 * heading, button, card, or container, to build the structure tree and group component
 * blueprints. Role is decided from aria role, then, for the tags that only package what they
 * hold, from visual evidence, and only then from the tag map: a card has a visual container
 * shape, and a container is a flex/grid with children. Ported by rewriting from v1
 * schema/dom-classifier.ts.
 */

/** The semantic roles an element can be classified into. */
export type SemanticRole =
	| 'heading' | 'paragraph' | 'button' | 'link' | 'input'
	| 'image' | 'nav' | 'list' | 'card' | 'section'
	| 'container' | 'text' | 'generic';

/** Tag name to role. */
const TAG_ROLE_MAP: Record<string, SemanticRole> = {
	h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
	p: 'paragraph', blockquote: 'paragraph',
	button: 'button',
	a: 'link',
	input: 'input', textarea: 'input', select: 'input',
	img: 'image', svg: 'image', picture: 'image', video: 'image',
	nav: 'nav',
	ul: 'list', ol: 'list',
	section: 'section', main: 'section', header: 'section', footer: 'section', aside: 'section', article: 'section',
	span: 'text', em: 'text', strong: 'text', small: 'text', label: 'text', b: 'text', i: 'text',
};

/** Aria role to semantic role. */
const ARIA_ROLE_MAP: Record<string, SemanticRole> = {
	button: 'button', link: 'link', navigation: 'nav', list: 'list', heading: 'heading',
	textbox: 'input', img: 'image', banner: 'section', main: 'section', contentinfo: 'section',
	complementary: 'section', region: 'section',
};

/** Tags always skipped during the schema walk. */
export const SKIP_TAGS = new Set(['script', 'noscript', 'style', 'template', 'iframe', 'link', 'meta', 'head', 'base', 'br', 'wbr']);

/**
 * Tags that only package what they hold, so what the element visibly is outranks what it is
 * called. An `<article>` styled exactly like a card is a card; reading the tag map first said
 * `section` and the card blueprint never saw it, which is why the fixture had to use divs to
 * test cards at all.
 */
const CONTAINERISH_TAGS = new Set(['article', 'section', 'aside', 'li', 'div']);

/** Classifies an element into a semantic role. */
export function classifyElement(element: Element): SemanticRole {
	const tag = element.tagName.toLowerCase();

	// Aria keeps first priority: an author who names a role has said what the element is.
	const ariaRole = element.getAttribute('role');
	if (ariaRole && ARIA_ROLE_MAP[ariaRole]) return ARIA_ROLE_MAP[ariaRole];

	// A tag that names what it is answers straight away. A tag that only packages what it holds
	// waits for the visual evidence below, and takes its turn as the fallback afterwards.
	const mapped = TAG_ROLE_MAP[tag];
	if (mapped && !CONTAINERISH_TAGS.has(tag)) return mapped;

	const computed = window.getComputedStyle(element);
	if (isClickable(element, computed)) return 'button';
	if (isCard(element, computed)) return 'card';
	if (mapped) return mapped;
	if (isContainer(computed, element)) return 'container';
	return 'generic';
}

/** A node that behaves like a button: focusable or click-handled, with a pointer cursor. */
function isClickable(element: Element, computed: CSSStyleDeclaration): boolean {
	if (element.getAttribute('tabindex') !== '0' && !element.getAttribute('onclick')) return false;
	return computed.cursor === 'pointer';
}

/** True when an element is rendered, by display/visibility/opacity and a non-zero box. */
export function isElementVisible(element: Element): boolean {
	const computed = window.getComputedStyle(element);
	if (computed.display === 'none' || computed.visibility === 'hidden') return false;
	if (computed.opacity === '0' && !isRevealPending(computed)) return false;
	const rect = element.getBoundingClientRect();
	return !(rect.width === 0 && rect.height === 0);
}

/**
 * True when an opacity-0 element is authored to appear rather than to stay hidden.
 *
 * A scroll-reveal library holds its content at opacity 0 until it enters the viewport, so a
 * section below the last scroll step, or one a library re-hides, is at opacity 0 when the schema
 * reads it and vanishes from the page entirely. An element with an opacity transition or an
 * animation declared was written to fade in. Flow position is what tells it apart from a dropdown
 * or a tooltip hidden the same way: reveal content is in flow, an overlay is taken out of it.
 */
function isRevealPending(computed: CSSStyleDeclaration): boolean {
	if (computed.position === 'absolute' || computed.position === 'fixed') return false;
	if (/\bopacity\b|\ball\b/.test(computed.transitionProperty || '')) return true;
	const animation = computed.animationName;
	return !!animation && animation !== 'none';
}

/**
 * Card heuristic: a visual container, meaning border / shadow / radius / background
 * that differs from its parent, with structured children, excluding modals, dialogs,
 * pills, tiny boxes, and absolutely-positioned decorations.
 */
function isCard(element: Element, computed: CSSStyleDeclaration): boolean {
	const hasBorder = computed.borderWidth !== '0px' && computed.borderStyle !== 'none';
	const hasShadow = computed.boxShadow !== 'none';
	const hasRadius = computed.borderRadius !== '0px';
	const hasBg = computed.backgroundColor !== 'rgba(0, 0, 0, 0)' && computed.backgroundColor !== 'transparent';

	const tag = element.tagName.toLowerCase();
	if (tag === 'form' || tag === 'dialog') return false;
	const role = element.getAttribute('role');
	if (role === 'dialog' || role === 'alertdialog' || role === 'form') return false;
	if (/modal|dialog|popup|dropdown|tooltip|popover|drawer|overlay/.test(classNameOf(element))) return false;

	let hasBgDifferentiation = false;
	if (hasBg && element.parentElement) {
		const parentBg = window.getComputedStyle(element.parentElement).backgroundColor;
		hasBgDifferentiation = computed.backgroundColor !== parentBg;
	}

	if (!hasBorder && !hasShadow && !hasBgDifferentiation) return false;
	if (element.children.length < 2) return false;
	if (parseFloat(computed.borderRadius) > 9999) return false; // Pill / chip, not a card.

	const rect = element.getBoundingClientRect();
	if (rect.width < 120 || rect.height < 80) return false;
	if (computed.position === 'absolute' || computed.position === 'fixed') return false;

	const hasImage = element.querySelector('img, picture, video, svg') !== null;
	const hasText = element.querySelector('p, h2, h3, h4, span') !== null;
	const hasButton = element.querySelector('button, a[class*="btn"], a[class*="button"]') !== null;
	const hasStructuredContent = hasText && (hasImage || hasButton);

	const visuallyCard = (hasShadow || (hasBorder && hasRadius) || hasBgDifferentiation) && (hasBg || hasShadow);
	return visuallyCard || (hasBgDifferentiation && hasStructuredContent);
}

/** True for a flex/grid layout container with children. */
function isContainer(computed: CSSStyleDeclaration, element: Element): boolean {
	const display = computed.display;
	const isFlexOrGrid = display === 'flex' || display === 'inline-flex' || display === 'grid' || display === 'inline-grid';
	return isFlexOrGrid && element.children.length > 0;
}

/** Lowercased class list of an element, handling svg's SVGAnimatedString className. */
export function classNameOf(element: Element): string {
	const raw = typeof element.className === 'string' ? element.className : (element.className as unknown as SVGAnimatedString)?.baseVal || '';
	return raw.toLowerCase();
}
