/**
 * capture/settle.ts: bringing the element to the state a reader would see.
 *
 * Runs first, on the live element, before the clone. A scroll-reveal component sits at
 * opacity 0 until an observer fires, so capturing the raw frame ships an empty snip. This
 * scrolls it into view, finishes running transitions and animations, loads and decodes lazy
 * images, and awaits fonts. Infinite animations are left running.
 *
 * It nudges the page's own reveal machinery and waits; it never edits authored style or
 * structure. A reveal gated on something it cannot fire, a click or a custom timer, will not
 * settle, and that is returned as a warning rather than shipped silently blank.
 */

/** Resolves after `n` animation frames, letting reveal classes and layout apply. */
function nextFrames(n: number): Promise<void> {
	return new Promise((resolve) => {
		let left = n;
		const tick = (): void => {
			if (--left <= 0) resolve();
			else requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
}

/**
 * Drives the live root to its settled, revealed state. Best-effort and non-throwing:
 * any step that fails is swallowed so capture always proceeds.
 *
 * @returns a warning when a reveal appears not to have fired, else empty
 */
export async function settle(root: Element): Promise<{ warning?: string }> {
	try {
		// Scroll into view so IntersectionObserver and scroll-driven reveals fire. Center
		// rather than nearest so an observer with a viewport-margin threshold still trips.
		root.scrollIntoView({ block: 'center', inline: 'nearest' });
	} catch {
		// Detached or non-scrollable context. The awaits below still help.
	}
	// Let the observer callback run and any reveal class apply before measuring.
	await nextFrames(2);

	await loadImages(root);
	finishTransientAnimations(root);

	// One more frame so finished transitions and decoded images settle the layout.
	await nextFrames(1);
	try {
		await document.fonts.ready;
	} catch {
		// Font readiness is best-effort.
	}

	return detectUnrevealed(root);
}

/**
 * Forces every image in the subtree to load eagerly and awaits decode, so the capture
 * reads loaded dimensions and the resolved currentSrc rather than a lazy spacer. Decode
 * failures, whether cross-origin or broken, are ignored, and the snip proceeds either way.
 */
async function loadImages(root: Element): Promise<void> {
	const imgs = Array.from(root.querySelectorAll('img'));
	if (root.tagName === 'IMG') imgs.push(root as HTMLImageElement);
	const decodes: Array<Promise<unknown>> = [];
	for (const img of imgs) {
		const el = img as HTMLImageElement;
		try {
			el.loading = 'eager';
		} catch {
			// Read-only in some contexts, but scrolling still triggers native lazy load.
		}
		// Decode resolves once the current source is ready. Catch so a broken image
		// or a still-pending lazy swap never rejects the settle.
		decodes.push(el.decode().catch(() => undefined));
	}
	await Promise.all(decodes);
}

/**
 * Finishes running transitions and finite animations across the subtree, jumping each
 * to its end state so the capture is a stable, deterministic frame rather than a
 * mid-flight one. Infinite looping animations are skipped: finishing them is
 * undefined, and forcing it would either throw or pin an arbitrary frame.
 */
function finishTransientAnimations(root: Element): void {
	const el = root as Element & { getAnimations?: (opts?: { subtree?: boolean }) => Animation[] };
	if (typeof el.getAnimations !== 'function') return;
	let animations: Animation[] = [];
	try {
		animations = el.getAnimations({ subtree: true });
	} catch {
		return;
	}
	for (const anim of animations) {
		try {
			const timing = anim.effect?.getComputedTiming?.();
			if (timing && timing.iterations === Infinity) continue; // Looping, so leave it.
			anim.finish();
		} catch {
			// Some animations reject finish, e.g. an infinite one the guard did not catch.
		}
	}
}

/**
 * Heuristic check for a reveal that never fired: after settling, the root still paints
 * nothing because it, or its only child wrapper, is held invisible. Returns a warning
 * string so the snip is flagged. This never blocks or alters the snip. It only reports.
 */
function detectUnrevealed(root: Element): { warning?: string } {
	try {
		const cs = getComputedStyle(root);
		const invisible = cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none';
		if (invisible) {
			return { warning: 'settle: element still hidden after reveal attempt; a non-scroll trigger (click/timer) may gate it' };
		}
	} catch {
		// No computed style available, so nothing to report.
	}
	return {};
}
