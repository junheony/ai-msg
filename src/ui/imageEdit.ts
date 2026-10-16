/**
 * Pure geometry of the attachment image editor (ImageEditor): rotation by quarter turns, the crop rectangle and its
 * handles, display scaling and the output type. All coordinates are image pixels — "original" is the decoded image
 * (EXIF already applied), "rotated" is that image after the editor's rotation, which is where the crop lives.
 */

export type Rotation = 0 | 90 | 180 | 270;
export type Size = { w: number; h: number };
export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type Handle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export const CORNER_HANDLES: readonly Handle[] = ['nw', 'ne', 'se', 'sw'];

/** One more quarter turn clockwise. */
export function nextRotation(r: Rotation): Rotation {
  return ((r + 90) % 360) as Rotation;
}

/** Size of the original image once rotated by `r`. */
export function rotatedSize(size: Size, r: Rotation): Size {
  return r === 90 || r === 270 ? { w: size.h, h: size.w } : { w: size.w, h: size.h };
}

/** Original → rotated coordinates (clockwise turn of an image of `size`). */
export function toRotated(p: Point, size: Size, r: Rotation): Point {
  switch (r) {
    case 0: return { x: p.x, y: p.y };
    case 90: return { x: size.h - p.y, y: p.x };
    case 180: return { x: size.w - p.x, y: size.h - p.y };
    case 270: return { x: p.y, y: size.w - p.x };
  }
}

/** Rotated → original coordinates; the inverse of toRotated. */
export function fromRotated(p: Point, size: Size, r: Rotation): Point {
  switch (r) {
    case 0: return { x: p.x, y: p.y };
    case 90: return { x: p.y, y: size.h - p.x };
    case 180: return { x: size.w - p.x, y: size.h - p.y };
    case 270: return { x: size.w - p.y, y: p.x };
  }
}

/** Canvas transform that draws the original image rotated: `ctx.translate(tx, ty); ctx.rotate(angle)`. */
export function rotationTransform(size: Size, r: Rotation): { tx: number; ty: number; angle: number } {
  const angle = (r * Math.PI) / 180;
  switch (r) {
    case 0: return { tx: 0, ty: 0, angle };
    case 90: return { tx: size.h, ty: 0, angle };
    case 180: return { tx: size.w, ty: size.h, angle };
    case 270: return { tx: 0, ty: size.w, angle };
  }
}

/** A rectangle in a space of size `before`, carried along one more clockwise quarter turn of that space. */
export function rotateRectCW(r: Rect, before: Size): Rect {
  return { x: before.h - (r.y + r.h), y: r.x, w: r.h, h: r.w };
}

export function fullRect(size: Size): Rect {
  return { x: 0, y: 0, w: size.w, h: size.h };
}

export function sameRect(a: Rect, b: Rect, eps = 0.5): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.w - b.w) <= eps && Math.abs(a.h - b.h) <= eps;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Moves `r` by (dx, dy), kept inside `bounds` (its size never changes). */
export function moveRect(r: Rect, dx: number, dy: number, bounds: Size): Rect {
  return { x: clamp(r.x + dx, 0, bounds.w - r.w), y: clamp(r.y + dy, 0, bounds.h - r.h), w: r.w, h: r.h };
}

/**
 * Drags `handle` of `r` to the point `p`: the opposite side (or corner) stays put, the rect stays inside `bounds` and
 * at least `min` on each side. With `aspect` (w / h) only corners resize — an edge handle acts as its clockwise corner —
 * and the ratio holds.
 */
export function resizeRect(r: Rect, handle: Handle, p: Point, bounds: Size, min: number, aspect: number | null = null): Rect {
  const m = Math.min(min, bounds.w, bounds.h);
  if (!aspect) {
    let left = r.x, top = r.y, right = r.x + r.w, bottom = r.y + r.h;
    if (handle.includes('w')) left = clamp(p.x, 0, right - m);
    if (handle.includes('e')) right = clamp(p.x, left + m, bounds.w);
    if (handle.includes('n')) top = clamp(p.y, 0, bottom - m);
    if (handle.includes('s')) bottom = clamp(p.y, top + m, bounds.h);
    return { x: left, y: top, w: right - left, h: bottom - top };
  }
  const corner: Handle = handle === 'n' ? 'ne' : handle === 'e' ? 'se' : handle === 's' ? 'sw' : handle === 'w' ? 'nw' : handle;
  const west = corner.includes('w'), north = corner.includes('n');
  const ax = west ? r.x + r.w : r.x, ay = north ? r.y + r.h : r.y;
  const maxW = west ? ax : bounds.w - ax, maxH = north ? ay : bounds.h - ay;
  let w = Math.max(0, west ? ax - p.x : p.x - ax);
  let h = Math.max(0, north ? ay - p.y : p.y - ay);
  if (w / Math.max(h, 1e-9) > aspect) w = h * aspect; else h = w / aspect;
  const minW = aspect >= 1 ? m * aspect : m;
  if (w < minW) { w = minW; h = w / aspect; }
  if (w > maxW) { w = maxW; h = w / aspect; }
  if (h > maxH) { h = maxH; w = h * aspect; }
  return { x: west ? ax - w : ax, y: north ? ay - h : ay, w, h };
}

/** The largest rect of ratio `aspect` (w / h) centered in `within`. */
export function fitAspect(within: Rect, aspect: number): Rect {
  let w = within.w, h = w / aspect;
  if (h > within.h) { h = within.h; w = h * aspect; }
  return { x: within.x + (within.w - w) / 2, y: within.y + (within.h - h) / 2, w, h };
}

/** Display scale of an image of `size` in a box of `avail` (never enlarged). */
export function fitScale(size: Size, avail: Size): number {
  if (size.w <= 0 || size.h <= 0 || avail.w <= 0 || avail.h <= 0) return 1;
  return Math.min(1, avail.w / size.w, avail.h / size.h);
}

/** The crop in whole pixels, inside `bounds` and at least 1×1 (what the output canvas gets). */
export function pixelRect(r: Rect, bounds: Size): Rect {
  const x = clamp(Math.round(r.x), 0, bounds.w - 1), y = clamp(Math.round(r.y), 0, bounds.h - 1);
  return { x, y, w: clamp(Math.round(r.x + r.w) - x, 1, bounds.w - x), h: clamp(Math.round(r.y + r.h) - y, 1, bounds.h - y) };
}

/**
 * Output canvas cap. iOS Safari refuses a canvas over 16,777,216 pixels (4096²): getContext / toBlob then fail without
 * an error (a blank or null image). 16 M stays under it with margin; a 12 MP phone photo (4032×3024) still goes 1:1,
 * a 48 MP one is scaled down to fit.
 */
export const MAX_CANVAS_PIXELS = 16_000_000;
export function outputScale(size: Size, maxPixels = MAX_CANVAS_PIXELS): number {
  const area = size.w * size.h;
  return area > maxPixels ? Math.sqrt(maxPixels / area) : 1;
}

/**
 * Photo-like files (JPEG, HEIC/HEIF, WebP, AVIF) come out JPEG; anything else (PNG screenshots, GIF, no extension) PNG.
 * Judged by the file name: the editor loads through <img> (the CSP's connect-src has no blob:, so it can't fetch the
 * local preview to read its type).
 */
export function outputType(name: string): 'image/jpeg' | 'image/png' {
  return /\.(jpe?g|heic|heif|webp|avif)$/i.test(name) ? 'image/jpeg' : 'image/png';
}

/** JPEG qualities tried in turn until the result fits the upload limit. */
export const JPEG_QUALITIES = [0.92, 0.85, 0.75] as const;

/** `name` with the extension of `mime` (`shot.webp` → `shot.png`; a matching extension is kept). */
export function editedName(name: string, mime: 'image/jpeg' | 'image/png'): string {
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'image';
  if (mime === 'image/jpeg') return /\.jpe?g$/i.test(name) ? name : `${base}.jpg`;
  return /\.png$/i.test(name) ? name : `${base}.png`;
}

/** Pen width in image pixels: visible on a phone screenshot and on a 4000 px photo alike. */
export function penWidth(size: Size): number {
  return Math.max(3, Math.round(Math.max(size.w, size.h) / 250));
}
