/**
 * Generate the shipped logo/favicon set from the design master.
 *
 *   node scripts/logo-assets.mjs [master.png]
 *
 * The master is a 2048x2048 PNG on a white field with wide margins — fine as a
 * source, useless as a favicon (at 32px the fish would be a few pixels wide) and
 * wrong on this UI, which is dark (`--bg: #0e1116`): a white square would sit on
 * the page as a bright box. So the derivatives are cropped and cut out, not just
 * scaled.
 *
 * Three things this does that a plain resize would get wrong:
 *
 * - **The crop is the fish's bounding box** plus a margin, so the subject fills
 *   the icon instead of floating in the middle of a mostly-white square.
 * - **The mask comes from the master, not from guessing.** A master that already
 *   carries an alpha channel is cropped to its ALPHA bounding box and shipped as
 *   is — transparent background, no tile. A flat opaque master (the earlier
 *   artwork was white-on-white) instead keeps its field and gets an antialiased
 *   rounded-rect so it reads as an app icon on the dark UI. Keying the white out
 *   of such a master is not an option and was measured: the fish's white stripes
 *   are contiguous with the white background, so a border flood fill reaches them
 *   and at tolerance 0 only 8% of the white pixels survive.
 * - **Resampling is alpha-premultiplied**, so the transparent area outside the
 *   rounded corners does not bleed a fringe into the tile edge as it shrinks.
 *
 * Pure Node — no image dependency. PNG is zlib-compressed filtered scanlines,
 * which node:zlib already handles; the rest is a few dozen lines.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { inflateSync, deflateSync } from "node:zlib";

// ---------------------------------------------------------------- decode ----

/** Decode a non-interlaced 8-bit RGB/RGBA PNG into { width, height, data (RGBA) }. */
function decodePng(buf) {
	if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
	let pos = 8;
	let width = 0;
	let height = 0;
	let channels = 0;
	const idat = [];
	while (pos < buf.length) {
		const len = buf.readUInt32BE(pos);
		const type = buf.toString("ascii", pos + 4, pos + 8);
		const body = buf.subarray(pos + 8, pos + 8 + len);
		if (type === "IHDR") {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			const depth = body[8];
			const colorType = body[9];
			const interlace = body[12];
			if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
			if (interlace !== 0) throw new Error("interlaced PNG is not supported");
			if (colorType === 2) channels = 3;
			else if (colorType === 6) channels = 4;
			else throw new Error(`unsupported colour type ${colorType} (need 2 or 6)`);
		} else if (type === "IDAT") idat.push(body);
		else if (type === "IEND") break;
		pos += 12 + len;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const out = Buffer.alloc(width * height * 4);
	const line = Buffer.alloc(stride);
	const prev = Buffer.alloc(stride);
	let src = 0;
	for (let y = 0; y < height; y++) {
		const filter = raw[src++];
		raw.copy(line, 0, src, src + stride);
		src += stride;
		// Undo the per-scanline filter (PNG spec 9.2).
		for (let i = 0; i < stride; i++) {
			const a = i >= channels ? line[i - channels] : 0;
			const b = prev[i];
			const c = i >= channels ? prev[i - channels] : 0;
			let v = line[i];
			if (filter === 1) v += a;
			else if (filter === 2) v += b;
			else if (filter === 3) v += (a + b) >> 1;
			else if (filter === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			line[i] = v & 0xff;
		}
		line.copy(prev);
		for (let x = 0; x < width; x++) {
			const s = x * channels;
			const d = (y * width + x) * 4;
			out[d] = line[s];
			out[d + 1] = line[s + 1];
			out[d + 2] = line[s + 2];
			out[d + 3] = channels === 4 ? line[s + 3] : 255;
		}
	}
	return { width, height, data: out };
}

// ---------------------------------------------------------------- encode ----

const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();

function crc32(buf) {
	let c = -1;
	for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

function chunk(type, body) {
	const out = Buffer.alloc(body.length + 12);
	out.writeUInt32BE(body.length, 0);
	out.write(type, 4, "ascii");
	body.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
	return out;
}

/** Encode RGBA pixels as an 8-bit RGBA PNG. Filter 0 + max deflate: these are flat-colour icons. */
function encodePng({ width, height, data }) {
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0; // filter: none
		data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // colour type: RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// ------------------------------------------------------------ operations ----

/** Does the master carry real transparency, or is it a flat opaque image? */
function hasAlpha(img) {
	const { width, height, data } = img;
	for (let i = 0; i < width * height; i++) if (data[i * 4 + 3] < 250) return true;
	return false;
}

/**
 * Is this pixel part of the white field rather than the artwork?
 *
 * The threshold is deliberately loose (40, not a few counts off pure white).
 * The master is a rendered image whose margin is not perfectly uniform, and a
 * tight threshold treats that faint noise as artwork — which pushed the measured
 * bounding box out to 1589x1985 for a fish that is actually 1120x759. Every real
 * ink colour here (orange ~230,126,34; outline ~60,60,60) is far outside 40.
 */
const isBackground = (data, i, tolerance = 40) =>
	data[i * 4] >= 255 - tolerance && data[i * 4 + 1] >= 255 - tolerance && data[i * 4 + 2] >= 255 - tolerance;

/**
 * Round the tile's corners with an antialiased mask.
 *
 * This replaces the transparent-background approach, which cannot work here:
 * the fish's white stripes are contiguous with the white field, so any fill or
 * colour key that removes the background also removes the stripes. Rounding
 * touches only the four corners and leaves the artwork untouched.
 */
function roundCorners(img, radiusRatio = 0.2) {
	const { width, height, data } = img;
	const r = Math.round(Math.min(width, height) * radiusRatio);
	// Supersample the corner arc so the edge is smooth at every output size.
	const SS = 4;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			// Distance from the nearest rounded corner's centre.
			const cx = x < r ? r : x >= width - r ? width - r - 1 : x;
			const cy = y < r ? r : y >= height - r ? height - r - 1 : y;
			// A pixel is outside a rounded rect only if it is in a CORNER box —
			// inside the corner's x band AND its y band. Testing `&&` here rounded
			// the straight edges too (the top edge midpoint came out at alpha 230).
			if (cx === x || cy === y) continue; // straight edge or interior
			let inside = 0;
			for (let sy = 0; sy < SS; sy++) {
				for (let sx = 0; sx < SS; sx++) {
					const px = x + (sx + 0.5) / SS - 0.5;
					const py = y + (sy + 0.5) / SS - 0.5;
					if (Math.hypot(px - cx, py - cy) <= r) inside++;
				}
			}
			const i = (y * width + x) * 4;
			data[i + 3] = Math.round((data[i + 3] * inside) / (SS * SS));
		}
	}
	return img;
}

/** Tight bounding box of the artwork (everything that is not the white field). */
function cropToSubject(img, padRatio = 0.14, alphaMask = false) {
	const { width, height, data } = img;
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = y * width + x;
			// Alpha decides when the master has it; otherwise fall back to "is this
			// the white field", which is all a flat master gives us to go on.
			const content = alphaMask ? data[i * 4 + 3] > 8 : !isBackground(data, i);
			if (content) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	if (maxX < 0) throw new Error("the whole image looks like background — nothing to crop to");
	// Square the box around the subject's centre so the icon is not distorted.
	const w = maxX - minX + 1;
	const h = maxY - minY + 1;
	const side = Math.round(Math.max(w, h) * (1 + padRatio * 2));
	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;
	const x0 = Math.round(cx - side / 2);
	const y0 = Math.round(cy - side / 2);
	// Outside the source: transparent for an alpha master, the white field for a
	// flat one — anything else would paint a border onto the icon.
	const out = Buffer.alloc(side * side * 4);
	if (!alphaMask) out.fill(255);
	for (let y = 0; y < side; y++) {
		const sy = y0 + y;
		if (sy < 0 || sy >= height) continue;
		for (let x = 0; x < side; x++) {
			const sx = x0 + x;
			if (sx < 0 || sx >= width) continue;
			data.copy(out, (y * side + x) * 4, (sy * width + sx) * 4, (sy * width + sx) * 4 + 4);
		}
	}
	return { width: side, height: side, data: out, box: { minX, minY, w, h } };
}

/**
 * Area-average downscale, premultiplied by alpha.
 *
 * Without premultiplication the fully transparent white field still contributes
 * its WHITE to averaged edge pixels, and the outline shrinks with a pale halo
 * around it. Weighting colour by alpha is what makes the cut-out edge clean.
 */
function resize(img, size) {
	const { width, height, data } = img;
	const out = Buffer.alloc(size * size * 4);
	const scale = width / size;
	for (let y = 0; y < size; y++) {
		const sy0 = Math.floor(y * scale);
		const sy1 = Math.min(height, Math.max(sy0 + 1, Math.floor((y + 1) * scale)));
		for (let x = 0; x < size; x++) {
			const sx0 = Math.floor(x * scale);
			const sx1 = Math.min(width, Math.max(sx0 + 1, Math.floor((x + 1) * scale)));
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let n = 0;
			for (let sy = sy0; sy < sy1; sy++) {
				for (let sx = sx0; sx < sx1; sx++) {
					const i = (sy * width + sx) * 4;
					const alpha = data[i + 3] / 255;
					r += data[i] * alpha;
					g += data[i + 1] * alpha;
					b += data[i + 2] * alpha;
					a += data[i + 3];
					n++;
				}
			}
			const d = (y * size + x) * 4;
			const avgA = a / n;
			// Un-premultiply: the accumulated colour is sum(colour * alpha), so the
			// true average colour is that sum divided by the accumulated alpha —
			// NOT by the pixel count as well, which would scale it by n and blow
			// every channel out to white.
			const k = a > 0 ? 255 / a : 0;
			out[d] = Math.min(255, Math.round(r * k));
			out[d + 1] = Math.min(255, Math.round(g * k));
			out[d + 2] = Math.min(255, Math.round(b * k));
			out[d + 3] = Math.round(avgA);
		}
	}
	return { width: size, height: size, data: out };
}

// ------------------------------------------------------------------ main ----

const master = resolve(process.argv[2] ?? "logo.png");
const source = decodePng(readFileSync(master));
console.log(`master: ${master} — ${source.width}x${source.height}, ${(readFileSync(master).length / 1024).toFixed(0)} KB`);

// A 512px copy of the UNPROCESSED master is what gets committed: the 2048px
// original is ~970 KB, and every shipped size is regenerable from 512 without a
// visible difference. Emitted before the crop so the pipeline stays reproducible
// from it (crop → round → resize), not from an already-cropped tile.
// Only when the input is genuinely larger — re-running against the committed
// master must not resample it into itself and lose a little each time.
if (source.width > 512) {
	mkdirSync("assets", { recursive: true });
	const masterSmall = encodePng(resize(source, 512));
	writeFileSync("assets/logo-master.png", masterSmall);
	console.log(`  ${"assets/logo-master.png".padEnd(42)}  512px  ${(masterSmall.length / 1024).toFixed(1).padStart(6)} KB  (committed master)`);
}

const alphaMask = hasAlpha(source);
// A transparent master needs no tile: its own alpha IS the shape, and rounding
// it would clip the artwork rather than frame it.
const cropped = cropToSubject(source, alphaMask ? 0.04 : 0.14, alphaMask);
const square = alphaMask ? cropped : roundCorners(cropped);
console.log(
	`master is ${alphaMask ? "transparent → cropped to its alpha bounds, no tile" : "opaque → white field kept, corners rounded into a tile"}`,
);
console.log(`subject box: ${cropped.box.w}x${cropped.box.h} → square ${square.width}px (master was ${source.width}px)`);

/** Everything the app and the README actually ship. */
const OUTPUTS = [
	["server/views/public/logo-128.png", 128], // topbar, 1x
	["server/views/public/logo-256.png", 256], // topbar, 2x (srcset)
	["server/views/public/favicon-32.png", 32],
	["server/views/public/favicon-16.png", 16],
	["server/views/public/apple-touch-icon.png", 180],
	["assets/logo-256.png", 256], // README
];

let total = 0;
for (const [rel, size] of OUTPUTS) {
	const png = encodePng(resize(square, size));
	mkdirSync(dirname(rel), { recursive: true });
	writeFileSync(rel, png);
	total += png.length;
	console.log(`  ${rel.padEnd(42)} ${String(size).padStart(4)}px  ${(png.length / 1024).toFixed(1).padStart(6)} KB`);
}
console.log(`total shipped: ${(total / 1024).toFixed(1)} KB`);
