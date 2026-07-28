/**
 * reconcile/standalone.ts: making the artifact's own render the source of truth.
 *
 * Runs last in reconcile. bake.ts validates each authored value by forcing it onto the live
 * element, and that test passes for values which only resolve because the page is present: a
 * var() defined on :root, an inherited body font, an ancestor-relative length. Those dangle
 * once the snip is pasted. So the baked clone is mounted in an isolated iframe carrying only
 * the ua stylesheet, and any property whose standalone value diverges from the original's live
 * one is corrected. One anchor fixes missing backgrounds, dangling tokens, lost display, and
 * collapsed geometry at once, because they are all the same defect.
 *
 * Box geometry is reconciled directionally, because the standalone render is authoritative on
 * size in one direction only. A non-replaced box that lost a sizing input from outside the snip
 * can only collapse, never grow, so its size is reclaimed only when it shrank; that is what
 * keeps a font-grown fallback box from being clipped back. A replaced element has an intrinsic
 * box, so either direction is a defect. See shouldReclaim in reconcile/diff.ts.
 *
 * The same anchor extends to structure: an element rendered in the original but absent from
 * the clone, dropped by some earlier handler, is restored, so a dropped element is corrected
 * universally rather than by special-casing whichever handler dropped it.
 *
 * It runs to a fixed point, because baking a structural property such as display changes
 * descendants' computed values.
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

/** Max reconciliation rounds. A structural property (display) can shift descendants'
 * computed values, so the diff is run to a fixed point. In practice it converges in
 * one or two passes, and the cap guards against a pathological non-converging cycle. */
const MAX_ROUNDS = 4;

/**
 * The closing reconciliation. It makes the standalone artifact's own render the source of
 * truth. For every paired element, any paint or box property whose standalone value
 * diverges from the original's live computed value, as shouldReclaim judges it, is
 * corrected by baking the original's resolved value, overriding an authored value that
 * does not reproduce standalone, such as a dangling token, a lost inherited font, an
 * ancestor-relative length, or a flex/grid track or inset that did not travel with the
 * snip. This is the single anchor that fixes missing backgrounds, dangling variables,
 * lost display, and collapsed box geometry at once.
 *
 * It runs to a fixed point: baking a structural property such as `display` can change
 * descendants' computed values, so each round re-reads the standalone render, with the
 * bakes applied to the in-frame copy too so the next round sees them, and stops
 * when a round makes no further corrections.
 *
 * @param captured - bakedStyles + clone are mutated in place
 */
export function reconcileStandalone(captured: Captured): void {
	try {
		withStandaloneFrame(captured, (mapCloneToFrame, win) => {
			const pairs = pairedSubtrees(captured.root, captured.clone).filter(([, clone]) => mapCloneToFrame.has(clone));
			// Snapshot each element's live computed values once. The live page never
			// changes, so this is the fixed target every round reconciles toward.
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
 * Bakes one recovered value onto the clone, persistently in bakedStyles plus the inline
 * style, and mirrors it onto the in-frame copy so the next reconciliation round reads the updated
 * standalone render. A property the element rejects is skipped via the inline try/catch.
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
 * Zeroes the snip root's own margin. A root margin positioned the element against
 * siblings that do not travel with the snip (the escaped context like the geometry
 * bake.ts recovers), so standalone it only pushes the component away from the origin.
 * A pasted component is positioned by its new container, not by a margin it carried
 * from the old page, so the faithful standalone form sits flush at the origin. Only the
 * root is affected. Descendant margins are real intra-component spacing and are kept.
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
 * Recovers the backdrop a snip lost with its ancestor chain. A component is often
 * authored with a transparent background because it sits on a section that paints the
 * color, such as a dark hero or a tinted band. Reparented standalone, that section is gone and
 * the component renders on white, so light text vanishes. This is the same escaped-
 * context recovery bake.ts already does for geometry (bakeEscapedLayout), applied to
 * paint. When the root's own background is transparent, bake the nearest opaque
 * ancestor background-color onto it.
 *
 * Runs after the standalone reconciliation deliberately. The reconciliation makes the
 * root reproduce its OWN computed style (a transparent background), and this is the
 * separate, later decision to restore the vanished backdrop, so it is not reverted.
 * Only the root needs it, because children paint over it. The recovered paint is a solid color,
 * or any reproducible backdrop image, such as a gradient, a tiled pattern, or a
 * cover/contain image. A positioned framed photo, sized for the full section, is still only flagged.
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
		// A nearer ancestor paints its backdrop with an image rather than a solid color.
		// A reproducible backdrop, such as a gradient, a repeated tile, or a cover/contain image, is a
		// paint that re-renders at any size, so baking the whole multi-layer value plus its
		// placement onto the root reproduces the backdrop and makes light-on-backdrop text
		// visible, even though it was authored for the whole section. A positioned framed
		// photo is sized for that section and cannot be reproduced, so that residual is flagged.
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
 * Whether a computed color paints nothing, in any notation that ends at zero alpha.
 *
 * Wider than isTransparentColor in utils/color.ts, which matches only the two spellings a
 * computed style produces for "nothing". Here any `rgba(r, g, b, 0)` counts, because this
 * decides whether an ancestor supplies a backdrop, and a zero-alpha color of any color
 * supplies none.
 */
function paintsNothing(color: string): boolean {
	return color === 'transparent' || color === 'rgba(0, 0, 0, 0)' || /,\s*0\)\s*$/.test(color);
}

/**
 * Whether a computed backdrop reproduces faithfully when baked onto the snip's own,
 * smaller box. A value with no raster layer is judged on its gradients, since a paint
 * function reproduces at any size. A raster layer reproduces in three cases. It tiles,
 * where a repeat fills any box. It scales, where a cover/contain image fits any box. Or
 * it paints the whole ancestor box, a full-bleed backdrop which can be rescaled to cover
 * the snip. A smaller placed raster is a framed image positioned for its section and does
 * not reproduce.
 */
function isReproducibleBackdrop(node: Element, cs: CSSStyleDeclaration): boolean {
	if (!/url\(/i.test(cs.backgroundImage)) return isReproducibleGradient(cs.backgroundImage);
	return backdropTiles(cs.backgroundRepeat) || backdropScales(cs.backgroundSize) || isFullBleed(node, cs.backgroundSize);
}

/**
 * The size and repeat to bake when reproducing a backdrop on the snip. A tiled or
 * scaling backdrop keeps its own placement: a tile repeats, and a cover/contain image fits.
 * A full-bleed raster sized in fixed pixels for the original section is rescaled to
 * cover, so it fills the smaller snip box rather than overflowing it.
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
 * Whether the first background-size layer paints the full width of the ancestor box, the
 * mark of a decorative full-bleed backdrop rather than a smaller placed image. A
 * percentage of 100 or more, or a length at least as wide as the box, is full-bleed. An
 * auto or smaller size is a placed image.
 */
function isFullBleed(node: Element, backgroundSize: string): boolean {
	const first = (backgroundSize.split(',')[0] ?? '').trim().split(/\s+/)[0] ?? '';
	if (first.endsWith('%')) return parseFloat(first) >= 100;
	if (first.endsWith('px')) return parseFloat(first) >= (node.clientWidth || 0) * 0.95;
	return false;
}

/**
 * Whether a computed background-image is purely css gradients: linear/radial/conic,
 * including repeating and -webkit- forms. A gradient is a paint function, not positioned
 * pixels, so baking it onto a smaller box still renders a faithful backdrop.
 */
function isReproducibleGradient(backgroundImage: string): boolean {
	if (/url\(/i.test(backgroundImage)) return false; // A raster layer cannot be reproduced.
	return /(?:^|[\s,])(?:-webkit-|-moz-|-o-)?(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(backgroundImage);
}
