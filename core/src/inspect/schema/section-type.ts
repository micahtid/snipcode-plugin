/**
 * inspect/schema/section-type.ts: naming a section from what was measured about it.
 *
 * Runs during the page-scoped inspect pass, but performs no dom queries of its own. Everything
 * it reads was measured first in sections.ts and layout.ts and handed over as SectionEvidence.
 *
 * That separation is the point. This pass used to grep class names for `stat|logo|price|hero`,
 * count question marks and currency symbols across a section's whole text, and match
 * `[class*="card"]`, which on a hashed-class or non-English page leaves most branches dead and
 * the surviving text branches misfiring. A hero whose copy said "1,900+ universities" came back
 * `stats`, and an agent trusts the label over the element list, so it built a stats band and
 * left the real hero as free space. A guess that can outrank a measurement is worse than no
 * guess, which is why anything under the confidence bar returns `content`.
 */
import { isBarShaped } from './discovery';
import type { ItemsReading, LayoutReading } from './layout';
import type { SectionType } from './types';

// Type scale is read in multiples of the page's own body size, never in fixed pixels. A fixed
// "32px is a headline" encodes one site's scale: a compact page whose h1 is 26px catalogs no
// heading anywhere and can never type as a hero, and an oversized editorial page calls every h4
// a headline. The body's computed font size is always defined, which the fitted type scale is
// not, so it is the yardstick even on a page with too few sizes to fit a scale to.
/** Multiple of the page's base font size at or above which a heading is the section's headline. */
export const HEADLINE_RATIO = 2;
/** Multiple of the base size at or above which a heading is a subhead rather than body text. */
export const SUBHEADING_RATIO = 1.25;
/** Fallback base size for a page whose body reports none. */
export const DEFAULT_BASE_FONT_PX = 16;
/** How many lines of a card are read when looking for a price. */
export const MAX_PRICE_LINES = 8;
/** How many of a run's items are read in full. A run's shape is settled well before this. */
export const MAX_ITEM_FACTS = 12;
/**
 * Share of the page past which a "section" is the page rather than a part of it.
 *
 * Discovery does not always resolve a wrapper, and when it hands back one box spanning everything
 * there is nothing to name: every reading below would be describing the page. Live pages showed
 * exactly this, a whole app root typed `hero` off its opening heading and a 196-post archive
 * typed `stats`. An unresolved page is honestly `content`.
 */
export const WHOLE_PAGE_SHARE = 0.8;

/** A hero opens the page: its box starts within this many viewports of the top. */
const HERO_TOP_VIEWPORTS = 1;
/** Fewest same-sized small boxes in a run before it reads as a wall of logos. */
const MIN_LOGO_ITEMS = 4;
/** A logo box is small: at most this many times the page's base font size tall. */
const LOGO_ITEM_HEIGHT_RATIO = 6;
/** Fewest repeated items before a run reads as a stats band, and as a row of cards. */
const MIN_STAT_ITEMS = 3;
const MIN_CARD_ITEMS = 2;
/** Fewest disclosure elements before a section reads as an faq. */
const MIN_ACCORDION_ITEMS = 3;
/** A line this short is a label, a price, or a stat, never a paragraph. */
const SHORT_LINE_CHARS = 40;
/** A stats block is a number and a caption: this many lines, this much text, at most. */
const MAX_STAT_LINES = 3;
const MAX_STAT_CHARS = 80;
/** A cta band is short: at most this share of the viewport's height. */
const CTA_MAX_HEIGHT_SHARE = 0.6;
/** A cta band sits this far into the page's section sequence. */
const CTA_TAIL_SHARE = 0.7;
/** Share of a run's items that must show a shape before the run counts as having it. */
const ITEM_MAJORITY = 0.6;

// Text shapes are script-neutral by construction. A hand-listed set of digits or currency signs
// is patchwork with more members: it classifies an English page and fails a Hindi or Japanese
// one for no reason the page itself contains.
/** Digits in any script, so a stat reads the same in Devanagari as in Latin. */
const NUMBER_LED = /^\p{Nd}/u;
/** Currency signs in any script. */
const CURRENCY = /\p{Sc}/u;
const CURRENCY_LED = /^\p{Sc}/u;
/** Opening and closing quotes in any script, plus the ascii double quote, which is not one. */
const QUOTED = /[\p{Pi}\p{Pf}"]/u;

/** What one repeated item is made of: the catalog's reading of it, and the lines it paints. */
export interface ItemFacts {
	shape: string[];
	lines: string[];
}

/** Everything measured about one section, which is all the classifier is allowed to see. */
export interface SectionEvidence {
	tag: string;
	rect: DOMRect;
	/** Position in the page's section sequence, so "near the end" is a measurement. */
	index: number;
	total: number;
	layout: LayoutReading;
	alignment: 'left' | 'center' | 'right';
	items: ItemsReading | null;
	itemFacts: ItemFacts[];
	catalog: string[];
	/** The largest heading the catalog saw, in px. 0 when the section carries no heading. */
	headingPx: number;
	baseFontPx: number;
	/** Disclosure elements the section holds, counted once so the classifier reads no dom. */
	accordionCount: number;
	/** True when this "section" spans most of the page, i.e. discovery did not resolve it. */
	coversPage: boolean;
	isNavBar: boolean;
	/** True once an earlier section took the hero, so a page reports at most one. */
	heroClaimed: boolean;
	/** Class list and id. A tie-breaker only: it can confirm a reading, never introduce one. */
	names: string;
}

/**
 * Names a section from what the measurements found, and returns `content` when they found
 * nothing conclusive.
 *
 * Structural readings run in order of confidence and answer on their own. Below that bar sit
 * the readings that are real but ambiguous, a run of heading-led blocks that is equally an faq
 * and a feature list, and those are settled by the section's class and id naming, which is
 * allowed to confirm a candidate the structure already produced and nothing else. A name can
 * never introduce a type by itself: on a hashed-class build there is no name to read, and on a
 * page in another language the words do not match, and in both cases the honest answer is the
 * generic one rather than a guess dressed as a measurement.
 */
export function classifySectionType(ev: SectionEvidence): SectionType {
	const structural = structuralType(ev);
	if (structural) return refineByName(structural, ev);
	// Naming cannot rescue an unresolved page either: every reading of it would be about the page.
	if (ev.coversPage) return 'content';

	const named = namedType(ev.names);
	if (named && weakCandidates(ev).includes(named)) return named;
	return 'content';
}

/** The readings confident enough to name a section on their own, most confident first. */
function structuralType(ev: SectionEvidence): SectionType | null {
	if (ev.tag === 'nav') return 'nav';
	if (ev.tag === 'footer') return 'footer';
	// A header or a scored bar that is still bar-shaped is the page's navigation. Height is what
	// keeps a full-height <header> hero from being read as a bar.
	if ((ev.isNavBar || ev.tag === 'header') && isBarShaped(ev.rect)) return 'nav';
	if (ev.coversPage) return null;

	if (isHero(ev)) return 'hero';
	if (isLogos(ev)) return 'logos';
	if (isStats(ev)) return 'stats';
	if (isPricing(ev)) return 'pricing';
	if (isTestimonials(ev)) return 'testimonials';
	if (ev.accordionCount >= MIN_ACCORDION_ITEMS) return 'faq';
	if (isFeatures(ev)) return 'features';
	if (isGallery(ev)) return 'gallery';
	if (isCta(ev)) return 'cta';
	return null;
}

/**
 * True when a section's items sit side by side, which is what "in one row" measures to.
 *
 * A scroll track is a row by construction, whatever column count its layout reports.
 */
function isRowOfItems(ev: SectionEvidence): boolean {
	return ev.layout.columns >= 2 || ev.layout.pattern === 'horizontal-scroll';
}

/**
 * The page's opening statement: a big heading in the first screen, before any other section has
 * claimed it.
 *
 * A cta raises confidence but is not required. Blogs, portfolios, and documentation open with
 * button-less heroes, and demanding a button there left the page's most important section
 * unlabelled, which is exactly the gap an agent fills with invention. Repetition disqualifies it
 * the other way: a hero is one statement, and a section holding a run of thirty-five identical
 * blocks is a feed with a heading on top of it.
 */
function isHero(ev: SectionEvidence): boolean {
	if (ev.heroClaimed || ev.items) return false;
	if (ev.rect.top + window.scrollY > window.innerHeight * HERO_TOP_VIEWPORTS) return false;
	return ev.headingPx >= ev.baseFontPx * HEADLINE_RATIO;
}

/** A row of small, same-sized boxes carrying an image or a short word: a logo wall or marquee. */
function isLogos(ev: SectionEvidence): boolean {
	if (!ev.items || ev.items.count < MIN_LOGO_ITEMS) return false;
	if (!isRowOfItems(ev)) return false;
	if (ev.items.height > ev.baseFontPx * LOGO_ITEM_HEIGHT_RATIO) return false;
	// A logo box is a mark or a wordmark: an image, or one short word, and nothing more.
	return majority(ev.itemFacts, (facts) => facts.lines.length <= 1 && isShort(facts.lines[0] ?? ''));
}

/**
 * A row of short, number-led blocks: "1,900+" over "universities", three or more across.
 *
 * The row is load-bearing, not decoration on the rule. A dated archive stacks its entries in one
 * column and every entry opens with its date, so read without the row a blog's post list came
 * back as a hundred-and-ninety-six-item stats band.
 */
function isStats(ev: SectionEvidence): boolean {
	if (!ev.items || ev.items.count < MIN_STAT_ITEMS) return false;
	if (!isRowOfItems(ev)) return false;
	return majority(ev.itemFacts, isNumberLed);
}

/** Repeated cards each carrying a price and a way to buy. */
function isPricing(ev: SectionEvidence): boolean {
	if (!ev.items || ev.items.count < MIN_CARD_ITEMS) return false;
	return majority(ev.itemFacts, (facts) => isCurrencyLed(facts) && hasButton(facts.shape));
}

/** Repeated cards each carrying a quote and the face or name behind it. */
function isTestimonials(ev: SectionEvidence): boolean {
	if (!ev.items || ev.items.count < MIN_CARD_ITEMS) return false;
	return majority(ev.itemFacts, (facts) => isQuoted(facts) && facts.shape.includes('image'));
}

/** Repeated cards each pairing a mark with a heading and a line of copy. */
function isFeatures(ev: SectionEvidence): boolean {
	if (!ev.items || ev.items.count < MIN_CARD_ITEMS) return false;
	return majority(ev.itemFacts, (facts) =>
		hasHeading(facts.shape) && facts.shape.includes('text') && (facts.shape.includes('icon') || facts.shape.includes('image')));
}

/** A run of images large enough to be the content rather than a mark standing in for a brand. */
function isGallery(ev: SectionEvidence): boolean {
	if (!ev.items || ev.items.count < MIN_STAT_ITEMS) return false;
	if (ev.items.height <= ev.baseFontPx * LOGO_ITEM_HEIGHT_RATIO) return false;
	return majority(ev.itemFacts, (facts) => facts.shape.length === 1 && facts.shape[0] === 'image' && facts.lines.length === 0);
}

/** A short, centered, button-bearing band near the end of the page. */
function isCta(ev: SectionEvidence): boolean {
	if (ev.items) return false;
	if (!hasButton(ev.catalog)) return false;
	if (ev.alignment !== 'center') return false;
	if (ev.rect.height > window.innerHeight * CTA_MAX_HEIGHT_SHARE) return false;
	return (ev.index + 1) / ev.total >= CTA_TAIL_SHARE;
}

/**
 * The readings that are real but ambiguous, which naming is allowed to settle.
 *
 * Each entry is a shape the measurements genuinely found; what they cannot say is which of two
 * things it is. A run of heading-led blocks is the same structure whether the page calls them
 * steps, questions, or features.
 */
function weakCandidates(ev: SectionEvidence): SectionType[] {
	const out: SectionType[] = [];
	const items = ev.items;

	if (items && items.count >= MIN_STAT_ITEMS && majority(ev.itemFacts, (facts) => hasHeading(facts.shape))) {
		out.push('faq', 'how-it-works', 'features');
	}
	if (items && items.count >= MIN_CARD_ITEMS && majority(ev.itemFacts, isQuoted)) out.push('testimonials');
	if (ev.accordionCount >= 1) out.push('faq');
	if (ev.layout.pattern.startsWith('two-column') && hasHeading(ev.catalog) && ev.catalog.includes('list')) out.push('features');
	if (hasButton(ev.catalog) && ev.rect.height <= window.innerHeight * CTA_MAX_HEIGHT_SHARE) out.push('cta');
	return out;
}

/**
 * Lets naming choose between two readings of one structure.
 *
 * A features grid and a how-it-works sequence are the same measurement, a run of cards each
 * holding a mark, a heading, and a line. Only the page's own naming separates them, and this is
 * the one place a name is allowed to change a structural answer.
 */
function refineByName(type: SectionType, ev: SectionEvidence): SectionType {
	if (type === 'features' && /how[-_]?it[-_]?works|steps?|process/.test(ev.names)) return 'how-it-works';
	return type;
}

/** The type a section's class and id naming suggests, or null when the naming says nothing. */
function namedType(names: string): SectionType | null {
	if (/hero|banner|jumbotron|splash/.test(names)) return 'hero';
	if (/how[-_]?it[-_]?works|steps?|process/.test(names)) return 'how-it-works';
	if (/feature|benefit|capability/.test(names)) return 'features';
	if (/testimon|review|quote/.test(names)) return 'testimonials';
	if (/pricing|plans?|tier/.test(names)) return 'pricing';
	if (/faq|question|accordion/.test(names)) return 'faq';
	if (/cta|call[-_]?to[-_]?action|get[-_]?started|sign[-_]?up/.test(names)) return 'cta';
	if (/stats?|numbers|metrics|counter/.test(names)) return 'stats';
	if (/logo|partner|client|brand|trusted/.test(names)) return 'logos';
	if (/gallery|portfolio|showcase/.test(names)) return 'gallery';
	return null;
}

/** True when enough of a run's items show a shape for it to be the run's shape. */
function majority(facts: ItemFacts[], predicate: (facts: ItemFacts) => boolean): boolean {
	if (facts.length === 0) return false;
	return facts.filter(predicate).length / facts.length >= ITEM_MAJORITY;
}

/** True for a line short enough to be a label rather than a sentence. */
function isShort(line: string): boolean {
	return line.length <= SHORT_LINE_CHARS;
}

/**
 * True when an item is a stat: a short block whose text leads with a number.
 *
 * The reading is on the item's own lines, never on the section's whole text. A hero whose copy
 * says "1,900+ universities" contains the same digits, and searching the section for them is
 * what voted that hero into `stats`.
 */
function isNumberLed(facts: ItemFacts): boolean {
	const lines = facts.lines.slice(0, MAX_STAT_LINES);
	if (lines.length === 0 || facts.lines.length > MAX_STAT_LINES) return false;
	if (lines.join(' ').length > MAX_STAT_CHARS) return false;
	return lines.some((line) => isShort(line) && NUMBER_LED.test(line));
}

/** True when an item carries a price: a short line led by a currency sign, or a number beside one. */
function isCurrencyLed(facts: ItemFacts): boolean {
	return facts.lines.some((line) => isShort(line) && (CURRENCY_LED.test(line) || (NUMBER_LED.test(line) && CURRENCY.test(line))));
}

/** True when an item carries quoted text, in whichever quotation marks its script uses. */
function isQuoted(facts: ItemFacts): boolean {
	return facts.lines.some((line) => QUOTED.test(line));
}

/** True when a catalog holds a heading at any level. Inside a card the headline is a subhead. */
function hasHeading(shape: string[]): boolean {
	return shape.includes('heading') || shape.includes('subheading');
}

/** True when a catalog holds a control to act on. */
function hasButton(shape: string[]): boolean {
	return shape.includes('button') || shape.includes('button-pair');
}
