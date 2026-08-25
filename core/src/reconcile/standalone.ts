/**
 * reconcile/standalone.ts: making the artifact's own render the source of truth.
 *
 * Runs last in reconcile. bake.ts validates each authored value against the live element, and
 * that test passes for values which only resolve because the page is there. A var() on :root,
 * an inherited body font, an ancestor-relative length. Those dangle once the snip is pasted.
 * So the baked clone is mounted in an isolated iframe with only the ua stylesheet, and any
 * property whose standalone value diverges from the live one is corrected. One anchor fixes
 * missing backgrounds, dangling tokens, lost display, and collapsed geometry at once, since
 * they are all the same defect. It runs to a fixed point, because baking display shifts
 * descendants.
 *
 * Geometry is the exception, authoritative on size in one direction only. A non-replaced box
 * that lost a sizing input can only collapse, never grow, so its size is reclaimed only when
 * it shrank. That is what keeps a font-grown fallback box from being clipped back. See
 * shouldReclaim in reconcile/diff.ts.
 */
import type { Captured } from '../types';
import { pairedSubtrees } from './match';
import { withStandaloneFrame } from './frame';
import { comparableProps, isReplacedElement, shouldReclaim } from './diff';

/** A bake the closing reconciliation will apply: a clone element gets `prop: value`. */
interface Override {
	clone: Element;
	framed: Element;
	prop: string;
	value: string;
}

/** Max reconciliation rounds. It converges in one or two; the cap guards a pathological cycle. */
const MAX_ROUNDS = 4;

/**
 * The closing reconciliation, which makes the artifact's own render the source of truth. On
 * every paired element, any property whose standalone value diverges from the live one, as
 * shouldReclaim judges it, is corrected. The live value bakes over the authored one.
 *
 * Each round re-reads the standalone render, with the bakes mirrored onto the in-frame copy so
 * the next round sees them, and stops when a round corrects nothing.
 *
 * @param captured - bakedStyles + clone are mutated in place
 */
export function reconcileStandalone(captured: Captured): void {
	try {
		withStandaloneFrame(captured, (mapCloneToFrame, win) => {
			const pairs = pairedSubtrees(captured.root, captured.clone).filter(([, clone]) => mapCloneToFrame.has(clone));
			// Snapshot the live computed values once: the fixed target every round aims at.
			const liveTargets = pairs.map(([original, clone]) => {
				const live = getComputedStyle(original);
				const want = new Map<string, string>();
				for (const prop of comparableProps(live)) {
					const value = live.getPropertyValue(prop);
					if (value !== '') want.set(prop, value);
				}
				return { clone, framed: mapCloneToFrame.get(clone)!, want, replaced: isReplacedElement(original) };
			});

			for (let round = 0; round < MAX_ROUNDS; round++) {
				const overrides: Override[] = [];
				for (const { clone, framed, want, replaced } of liveTargets) {
					const standalone = win.getComputedStyle(framed);
					const targetColor = want.get('color') ?? '';
					for (const [prop, value] of want) {
						if (shouldReclaim(prop, standalone.getPropertyValue(prop), value, replaced, targetColor)) {
							overrides.push({ clone, framed, prop, value });
						}
					}
				}
				if (overrides.length === 0) break; // Converged.
				for (const o of overrides) applyOverride(captured, o);
			}
		});
		recoverEscapedBackground(captured);
		zeroRootMargin(captured);
	} catch (err) {
		captured.warnings.push(`standalone reconcile: skipped (${(err as Error).message})`);
	}
}

/**
 * Bakes one recovered value onto the clone, in bakedStyles and the inline style. It is mirrored
 * onto the in-frame copy, so the next round reads the updated standalone render.
 */
function applyOverride(captured: Captured, o: Override): void {
	const baked = captured.bakedStyles.get(o.clone) ?? new Map<string, string>();
	baked.set(o.prop, o.value);
	captured.bakedStyles.set(o.clone, baked);
	try {
		(o.clone as HTMLElement).style.setProperty(o.prop, o.value);
	} catch {
		// Invalid for this element, so the baked-map entry is still recorded for emit.
	}
	try {
		(o.framed as HTMLElement).style.setProperty(o.prop, o.value);
	} catch {
		// Mirror is best-effort. A failure only costs a redundant next-round override.
	}
}

/**
 * Zeroes the snip root's own margin. That margin positioned the element against siblings that
 * do not travel with the snip, so standalone it only pushes the component off the origin. A
 * pasted component is placed by its new container. Descendant margins are real intra-component
 * spacing and are kept.
 *
 * @param captured - the root clone's baked margin is removed in place
 */
function zeroRootMargin(captured: Captured): void {
	const rootClone = captured.clone as HTMLElement;
	const baked = captured.bakedStyles.get(rootClone) ?? new Map<string, string>();
	for (const prop of ['margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left']) {
		baked.delete(prop);
		try {
			rootClone.style.removeProperty(prop);
		} catch {
			// Not removable for this element, so the baked-map delete is enough.
		}
	}
	baked.set('margin', '0');
	captured.bakedStyles.set(rootClone, baked);
	try {
		rootClone.style.setProperty('margin', '0');
	} catch {
		// Invalid for this element, so the baked-map entry still ships to emit.
	}
}

/**
 * Recovers the backdrop a snip lost with its ancestor chain. A component authored transparent
 * because it sits on a dark hero renders on white once reparented, and its light text
 * vanishes. So when the root paints nothing, the nearest ancestor backdrop is baked onto it.
 * Same escaped-context recovery bake.ts does for geometry, applied to paint.
 *
 * It runs after the standalone reconciliation on purpose. That pass makes the root reproduce
 * its own transparent background, and this is the separate later decision to restore what
 * vanished. Only the root needs it, since children paint over it.
 *
 * @param captured - the root clone's baked map + inline style are extended
 */
function recoverEscapedBackground(captured: Captured): void {
	const rootCs = getComputedStyle(captured.root);
	// The root already paints its own backdrop, an opaque color or any image, so trust it.
	if (!paintsNothing(rootCs.backgroundColor)) return;
	if (rootCs.backgroundImage && rootCs.backgroundImage !== 'none') return;

	let node = captured.root.parentElement;
	while (node && node !== document.documentElement) {
		const cs = getComputedStyle(node);
		if (!paintsNothing(cs.backgroundColor)) {
			bakeOnRoot(captured, 'background-color', cs.backgroundColor);
			return;
		}
		// An ancestor paints its backdrop with an image. A gradient, a tile, or a cover image
		// re-renders at any size, so baking the whole value plus its placement onto the root
		// reproduces it. A positioned framed photo is sized for that section and cannot be
		// reproduced, so it is flagged instead.
		if (cs.backgroundImage && cs.backgroundImage !== 'none') {
			if (isReproducibleBackdrop(node, cs)) {
				const place = backdropPlacement(cs);
				bakeOnRoot(captured, 'background-image', cs.backgroundImage);
				bakeOnRoot(captured, 'background-size', place.size);
				bakeOnRoot(captured, 'background-repeat', place.repeat);
				bakeOnRoot(captured, 'background-position', cs.backgroundPosition);
				return;
			}
			captured.warnings.push('standalone: element is transparent over an ancestor positioned background-image not in the snip; backdrop cannot be reproduced standalone');
			return;
		}
		node = node.parentElement;
	}
}

/** Bakes one recovered value onto the snip root: bakedStyles plus inline style. */
function bakeOnRoot(captured: Captured, prop: string, value: string): void {
	const rootClone = captured.clone as HTMLElement;
	const baked = captured.bakedStyles.get(rootClone) ?? new Map<string, string>();
	baked.set(prop, value);
	captured.bakedStyles.set(rootClone, baked);
	try {
		rootClone.style.setProperty(prop, value);
	} catch {
		// Invalid for this element, so the baked-map entry still ships to emit.
	}
}

/**
 * Whether a computed color paints nothing, in any notation ending at zero alpha. Wider than
 * isTransparentColor in utils/color.ts: here any `rgba(r, g, b, 0)` counts, because a
 * zero-alpha color of any hue supplies no backdrop.
 */
function paintsNothing(color: string): boolean {
	return color === 'transparent' || color === 'rgba(0, 0, 0, 0)' || /,\s*0\)\s*$/.test(color);
}

/**
 * Whether a backdrop reproduces faithfully on the snip's own smaller box. With no raster
 * layer it is judged on its gradients, which paint at any size. A raster reproduces when it
 * tiles, when it scales to cover or contain, or when it is full-bleed and so can be rescaled.
 * A smaller placed raster is a framed image and does not.
 */
function isReproducibleBackdrop(node: Element, cs: CSSStyleDeclaration): boolean {
	if (!/url\(/i.test(cs.backgroundImage)) return isReproducibleGradient(cs.backgroundImage);
	return backdropTiles(cs.backgroundRepeat) || backdropScales(cs.backgroundSize) || isFullBleed(node, cs.backgroundSize);
}

/**
 * The size and repeat to bake for a backdrop. A tiled or scaling one keeps its own placement.
 * A full-bleed raster sized in fixed pixels for the original section is rescaled to cover, so
 * it fills the smaller snip box rather than overflowing it.
 */
function backdropPlacement(cs: CSSStyleDeclaration): { size: string; repeat: string } {
	const keepsOwn = !/url\(/i.test(cs.backgroundImage) || backdropTiles(cs.backgroundRepeat) || backdropScales(cs.backgroundSize);
	if (keepsOwn) return { size: cs.backgroundSize, repeat: cs.backgroundRepeat };
	return { size: 'cover', repeat: 'no-repeat' };
}

/** Whether any background-repeat layer tiles, so the backdrop fills an arbitrary box. */
function backdropTiles(backgroundRepeat: string): boolean {
	return backgroundRepeat.split(',').some((layer) => {
		const r = layer.trim();
		return r !== 'no-repeat' && /repeat|round|space/i.test(r);
	});
}

/** Whether any background-size layer scales the image to its box (cover or contain). */
function backdropScales(backgroundSize: string): boolean {
	return /\b(?:cover|contain)\b/i.test(backgroundSize);
}

/**
 * Whether the first background-size layer covers the full width of the ancestor box, which
 * marks a decorative backdrop rather than a placed image. A percentage of 100 or more, or a
 * length as wide as the box, is full-bleed; auto or smaller is a placed image.
 */
function isFullBleed(node: Element, backgroundSize: string): boolean {
	const first = (backgroundSize.split(',')[0] ?? '').trim().split(/\s+/)[0] ?? '';
	if (first.endsWith('%')) return parseFloat(first) >= 100;
	if (first.endsWith('px')) return parseFloat(first) >= (node.clientWidth || 0) * 0.95;
	return false;
}

/**
 * Whether a background-image is purely css gradients, repeating and prefixed forms included.
 * A gradient is a paint function rather than positioned pixels, so it survives a smaller box.
 */
function isReproducibleGradient(backgroundImage: string): boolean {
	if (/url\(/i.test(backgroundImage)) return false; // A raster layer cannot be reproduced.
	return /(?:^|[\s,])(?:-webkit-|-moz-|-o-)?(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(backgroundImage);
}
