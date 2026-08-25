/**
 * resolve/font-bytes.ts: the two @font-face passes that run once the bytes are embedded.
 *
 * Split from resolve/fonts.ts, which decides which faces to keep and where they load from.
 * These two read the embedded payload instead, so they can only run after resolve/inline.ts
 * has turned each src into a data uri. One relabels a mislabeled container; the other
 * collapses faces carrying byte-identical payloads.
 */
import type { Captured, FontFace } from '../types';
import { faceWeightRange, normalizeFamily } from './fonts';

/** Each font container's leading magic bytes as hex, mapped to its true mime type. */
const FONT_MAGIC: Array<[string, string]> = [
	['774f4632', 'font/woff2'], // wOF2
	['774f4646', 'font/woff'], // wOFF
	['4f54544f', 'font/otf'], // OTTO, an OpenType/CFF outline font
	['74746366', 'font/collection'], // ttcf, a TrueType collection
	['00010000', 'font/ttf'], // TrueType outlines
	['74727565', 'font/ttf'], // 'true', a legacy TrueType tag
];

/**
 * Relabels every embedded font data uri with the mime its bytes actually are, read from the
 * container magic rather than the source's label. A woff2 served as `binary/octet-stream` is
 * corrected. Browsers sniff the bytes anyway, so this is a serialization fix; the honest label
 * is what gives the split-asset writer the right extension.
 *
 * @param captured - captured.fonts src strings are relabeled in place
 */
export function correctFontMime(captured: Captured): void {
	for (const font of captured.fonts) {
		font.src = font.src.replace(/data:([^;,)]*)(;base64)?,([A-Za-z0-9+/=]+)/g, (whole, _mime: string, base64: string, payload: string) => {
			if (!base64) return whole; // A url-encoded data uri is left as written, since its bytes are not base64.
			const mime = fontMimeFromBytes(payload);
			return mime ? `data:${mime};base64,${payload}` : whole;
		});
	}
}

/** The true mime of a base64 font payload, read from its container magic, or null if unknown. */
function fontMimeFromBytes(base64Payload: string): string | null {
	let head: string;
	try {
		head = atob(base64Payload.slice(0, 8)); // Eight base64 chars decode the four-byte magic.
	} catch {
		return null;
	}
	const magic = Array.from(head.slice(0, 4))
		.map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
		.join('');
	for (const [signature, mime] of FONT_MAGIC) if (magic === signature) return mime;
	return null;
}

/**
 * Collapses faces with identical bytes that differ only in weight into one `@font-face` whose
 * font-weight spans the merged range. A source shipping one file under three weights then
 * pays for those bytes once instead of three times and drops to a single rule.
 *
 * Byte identity is the strongest equivalence, and the browser resolves a weight-range face for
 * every weight the merged ones served, so the render is unchanged. Any other descriptor
 * difference keeps its own rule.
 */
export function mergeIdenticalFaces(captured: Captured): void {
	const groups = new Map<string, FontFace[]>();
	const order: string[] = [];
	for (const font of captured.fonts) {
		const key = faceMergeKey(font);
		let group = groups.get(key);
		if (!group) {
			groups.set(key, (group = []));
			order.push(key);
		}
		group.push(font);
	}
	captured.fonts = order.map((key) => {
		const group = groups.get(key)!;
		return group.length === 1 ? group[0]! : mergeWeightRange(group);
	});
}

/** A face's identity for merging: its family, its byte payload, and every descriptor but weight. */
function faceMergeKey(font: FontFace): string {
	const descriptors = Object.entries(font.descriptors)
		.filter(([name]) => name !== 'font-weight')
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, value]) => `${name}:${value}`)
		.join(';');
	const payload = font.src.match(/data:[^,]*,([A-Za-z0-9+/=]+)/);
	// The data uri payload identifies the bytes. A face still on a url groups by that url instead.
	return `${normalizeFamily(font.family).toLowerCase()}|${descriptors}|${payload ? payload[1] : font.src}`;
}

/** One face carrying the group's shared bytes and descriptors, its font-weight spanning the range. */
function mergeWeightRange(faces: FontFace[]): FontFace {
	let lo = Infinity;
	let hi = -Infinity;
	for (const face of faces) {
		const [flo, fhi] = faceWeightRange(face);
		lo = Math.min(lo, flo);
		hi = Math.max(hi, fhi);
	}
	const base = faces[0]!;
	return { family: base.family, src: base.src, descriptors: { ...base.descriptors, 'font-weight': lo === hi ? String(lo) : `${lo} ${hi}` } };
}
