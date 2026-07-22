/**
 * test/pixels.ts: shared png pixel-diff for the fidelity and parity benches.
 *
 * Both benches screenshot two renders and ask "how different are they?" This decodes
 * the pngs, crops both to their shared top-left region so pixelmatch gets matching
 * dimensions, and returns the fraction of mismatched pixels.
 */
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

/** Crop a decoded png to the top-left w×h into a fresh RGBA buffer. */
function cropTo(src: PNG, w: number, h: number): PNG {
	const out = new PNG({ width: w, height: h });
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const si = (src.width * y + x) << 2;
			const di = (w * y + x) << 2;
			out.data[di] = src.data[si]!;
			out.data[di + 1] = src.data[si + 1]!;
			out.data[di + 2] = src.data[si + 2]!;
			out.data[di + 3] = src.data[si + 3]!;
		}
	}
	return out;
}

/** Fraction of mismatched pixels over the overlapping top-left region of two pngs. */
export function mismatchRatio(a: Buffer, b: Buffer): number {
	const pa = PNG.sync.read(a);
	const pb = PNG.sync.read(b);
	const w = Math.min(pa.width, pb.width);
	const h = Math.min(pa.height, pb.height);
	if (w === 0 || h === 0) return 1;
	const ca = cropTo(pa, w, h);
	const cb = cropTo(pb, w, h);
	const diff = new PNG({ width: w, height: h });
	const bad = pixelmatch(ca.data, cb.data, diff.data, w, h, { threshold: 0.1 });
	return bad / (w * h);
}
