/**
 * runner/src/screenshot.ts: page and element captures.
 *
 * Uses Playwright's own screenshot paths rather than an image library. A full-page capture
 * serves candidates and schema, and an element-handle capture serves the builder-gate crop an
 * agent rebuilds from. That one re-resolves the selector to a handle, independent of the
 * in-page core resolution but landing on the same node.
 */
import type { Page } from 'playwright';

/** Full-page png, the whole scroll height. Bytes, for the caller to write. */
export async function fullPage(page: Page): Promise<Buffer> {
	return page.screenshot({ type: 'png', fullPage: true });
}

/** Png cropped to the first element matching selector, or null when it has no box. */
export async function elementCrop(page: Page, selector: string): Promise<Buffer | null> {
	try {
		const handle = await page.$(selector);
		if (!handle) return null;
		const box = await handle.boundingBox();
		if (!box || box.width === 0 || box.height === 0) return null;
		return await handle.screenshot({ type: 'png' });
	} catch {
		return null;
	}
}
