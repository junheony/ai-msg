// Generates the PWA icons and the notification badge as PNGs — no dependencies, the outputs are committed.
// Run: node scripts/gen-icons.mjs   (writes src/ui/public/icons/*.png)
//
// The app icon is the AI-MSG mark (docs/brand/ai-msg-mark-a.svg: a faceted crystal grain whose lower-left corner is a
// speech tail) in light facets on an indigo tile, drawn here from the same polygons (4x4 supersampled). The badge
// (Android shows it as a monochrome silhouette next to the notification — a colour icon with a background turns into a
// white square) is the silhouette alone, white on transparent, with the facet Y cut out.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '..', 'src', 'ui', 'public', 'icons');

// ---- PNG ----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** 8-bit truecolor PNG: `channels` 3 = RGB, 4 = RGBA. */
function encodePng(w, h, channels, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // colour type
  const stride = w * channels;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
// ---- The mark (24-unit box, the same numbers as BrandMark.tsx / the SVG) ----

const FACES = [
  { pts: [[12, 1.4], [20.31, 6.2], [12, 11], [3.69, 6.2]], rgb: [0xff, 0xff, 0xff] }, // top: the lit face
  { pts: [[3.69, 6.2], [12, 11], [12, 20.6], [8.26, 18.44], [4.1, 22.4], [5.19, 16.66], [3.69, 15.8]], rgb: [0xe0, 0xe7, 0xff] }, // left + tail
  { pts: [[12, 11], [20.31, 6.2], [20.31, 15.8], [12, 20.6]], rgb: [0xa5, 0xb4, 0xfc] }, // right: the shade
];
/** The facet edges cut out of the monochrome badge (centre lines, `CUT` units wide). */
const CUTS = [[[3.69, 6.2], [12, 11]], [[12, 11], [20.31, 6.2]], [[12, 11], [12, 20.6]]];
const CUT = 1.5;
/** The mark's visual centre in the box (its extent is x 3.69..20.31, y 1.4..22.4). */
const CENTER = [12, 11.9];
const TILE_TOP = [0x63, 0x66, 0xf1];
const TILE_BOTTOM = [0x43, 0x38, 0xca];

function inside(x, y, pts) {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
function segDist(px, py, [[ax, ay], [bx, by]]) {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}
const SS = 4;

/** The mark `fill` of the frame tall (24 units → fill·size px), centred: what covers each sample, or null. */
function sampler(size, fill) {
  const k = (fill * size) / 21; // the mark is 21 units tall
  return (x, y) => [CENTER[0] + (x - size / 2) / k, CENTER[1] + (y - size / 2) / k];
}

/** The app icon: the coloured mark on the indigo tile (vertical gradient), RGB out. */
function renderIcon(size, fill) {
  const out = Buffer.alloc(size * size * 3);
  const at = sampler(size, fill);
  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    const tile = TILE_TOP.map((c, i) => c + (TILE_BOTTOM[i] - c) * t);
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [u, v] = at(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          const face = FACES.find((f) => inside(u, v, f.pts));
          const rgb = face ? face.rgb : tile;
          for (let c = 0; c < 3; c++) acc[c] += rgb[c];
        }
      }
      for (let c = 0; c < 3; c++) out[(y * size + x) * 3 + c] = Math.round(acc[c] / (SS * SS));
    }
  }
  return out;
}

/** The badge: the white silhouette on transparent, the facet Y cut out. RGBA out. */
function renderBadge(size, fill) {
  const out = Buffer.alloc(size * size * 4);
  const at = sampler(size, fill);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [u, v] = at(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          if (!FACES.some((f) => inside(u, v, f.pts))) continue;
          if (CUTS.some((s) => segDist(u, v, s) <= CUT / 2)) continue;
          hit++;
        }
      }
      const i = (y * size + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = 0xff;
      out[i + 3] = Math.round((255 * hit) / (SS * SS));
    }
  }
  return out;
}

// ---- Outputs ----

fs.mkdirSync(OUT, { recursive: true });
const icons = [
  // The mark at 62% of the frame on the full-bleed tile (favicon, Android notification, iOS home screen).
  ['icon-192.png', 192, 0.62],
  ['icon-512.png', 512, 0.62],
  ['apple-touch-icon.png', 180, 0.62],
  // Maskable: the platform may crop to a circle of 80% — the mark (tail included) stays inside it at 48%.
  ['icon-maskable-512.png', 512, 0.48],
];
for (const [name, size, fill] of icons) {
  fs.writeFileSync(path.join(OUT, name), encodePng(size, size, 3, renderIcon(size, fill)));
  console.log(`wrote ${name} (${size}x${size})`);
}
fs.writeFileSync(path.join(OUT, 'badge-96.png'), encodePng(96, 96, 4, renderBadge(96, 0.84)));
console.log('wrote badge-96.png (96x96, alpha)');
