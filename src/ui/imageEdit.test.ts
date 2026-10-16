import { describe, expect, it } from 'vitest';
import {
  editedName, fitAspect, fitScale, fromRotated, fullRect, moveRect, nextRotation, outputScale, outputType, penWidth, pixelRect,
  resizeRect, rotateRectCW, rotatedSize, rotationTransform, sameRect, toRotated, type Rotation,
} from './imageEdit';

const size = { w: 400, h: 300 };
const ROTS: Rotation[] = [0, 90, 180, 270];

/** Applies rotationTransform to a point, as the canvas would. */
function viaCanvas(p: { x: number; y: number }, r: Rotation) {
  const { tx, ty, angle } = rotationTransform(size, r);
  const c = Math.round(Math.cos(angle)), s = Math.round(Math.sin(angle));
  return { x: tx + p.x * c - p.y * s, y: ty + p.x * s + p.y * c };
}

describe('imageEdit rotation', () => {
  it('turns clockwise in quarter steps and swaps the size on odd turns', () => {
    expect([0, 90, 180, 270].map((r) => nextRotation(r as Rotation))).toEqual([90, 180, 270, 0]);
    expect(rotatedSize(size, 0)).toEqual({ w: 400, h: 300 });
    expect(rotatedSize(size, 90)).toEqual({ w: 300, h: 400 });
    expect(rotatedSize(size, 180)).toEqual({ w: 400, h: 300 });
    expect(rotatedSize(size, 270)).toEqual({ w: 300, h: 400 });
  });

  it('maps the original top-left corner to the right place for each turn', () => {
    expect(toRotated({ x: 0, y: 0 }, size, 90)).toEqual({ x: 300, y: 0 }); // top-left → top-right
    expect(toRotated({ x: 0, y: 0 }, size, 180)).toEqual({ x: 400, y: 300 });
    expect(toRotated({ x: 0, y: 0 }, size, 270)).toEqual({ x: 0, y: 400 }); // top-left → bottom-left
  });

  it('fromRotated undoes toRotated, and the canvas transform agrees with toRotated', () => {
    const pts = [{ x: 0, y: 0 }, { x: 400, y: 300 }, { x: 37, y: 251 }, { x: 399, y: 1 }];
    for (const r of ROTS) for (const p of pts) {
      const q = toRotated(p, size, r);
      expect(fromRotated(q, size, r)).toEqual(p);
      expect(viaCanvas(p, r)).toEqual(q);
      const rs = rotatedSize(size, r);
      expect(q.x >= 0 && q.x <= rs.w && q.y >= 0 && q.y <= rs.h).toBe(true);
    }
  });

  it('carries a crop rect along a quarter turn, the same as rotating its corners', () => {
    const rect = { x: 10, y: 20, w: 100, h: 50 };
    const before = rotatedSize(size, 0);
    const out = rotateRectCW(rect, before);
    const a = toRotated({ x: rect.x, y: rect.y }, size, 90);
    const b = toRotated({ x: rect.x + rect.w, y: rect.y + rect.h }, size, 90);
    expect(out).toEqual({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: 50, h: 100 });
    // Four turns come back home; the full rect stays full.
    let r = rect, s = before;
    for (let i = 0; i < 4; i++) { r = rotateRectCW(r, s); s = { w: s.h, h: s.w }; }
    expect(r).toEqual(rect);
    expect(rotateRectCW(fullRect(size), size)).toEqual(fullRect(rotatedSize(size, 90)));
  });
});

describe('imageEdit crop', () => {
  const bounds = { w: 400, h: 300 };
  const r = { x: 100, y: 100, w: 100, h: 100 };

  it('moves inside the bounds without changing size', () => {
    expect(moveRect(r, 50, -20, bounds)).toEqual({ x: 150, y: 80, w: 100, h: 100 });
    expect(moveRect(r, 1000, 1000, bounds)).toEqual({ x: 300, y: 200, w: 100, h: 100 });
    expect(moveRect(r, -1000, -1000, bounds)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });

  it('free resize: the opposite side stays, clamped to bounds and the minimum size', () => {
    expect(resizeRect(r, 'se', { x: 250, y: 260 }, bounds, 20)).toEqual({ x: 100, y: 100, w: 150, h: 160 });
    expect(resizeRect(r, 'nw', { x: 50, y: 40 }, bounds, 20)).toEqual({ x: 50, y: 40, w: 150, h: 160 });
    expect(resizeRect(r, 'e', { x: 999, y: 0 }, bounds, 20)).toEqual({ x: 100, y: 100, w: 300, h: 100 }); // edge: one axis
    expect(resizeRect(r, 'n', { x: 0, y: -50 }, bounds, 20)).toEqual({ x: 100, y: 0, w: 100, h: 200 });
    expect(resizeRect(r, 'w', { x: 500, y: 0 }, bounds, 20)).toEqual({ x: 180, y: 100, w: 20, h: 100 }); // never inverts
    expect(resizeRect(r, 's', { x: 0, y: 0 }, bounds, 20)).toEqual({ x: 100, y: 100, w: 100, h: 20 });
  });

  it('fixed ratio: corners keep w / h and stop at the bounds', () => {
    const sq = resizeRect(r, 'se', { x: 300, y: 150 }, bounds, 20, 1);
    expect(sq.w).toBeCloseTo(sq.h);
    expect(sq).toMatchObject({ x: 100, y: 100 });
    const big = resizeRect(r, 'se', { x: 9999, y: 9999 }, bounds, 20, 1);
    expect(big).toEqual({ x: 100, y: 100, w: 200, h: 200 }); // bottom edge (300) stops it
    const wide = resizeRect(r, 'nw', { x: 0, y: 0 }, bounds, 20, 2);
    expect(wide.w / wide.h).toBeCloseTo(2);
    expect(wide.x + wide.w).toBe(200); // anchor (se corner) kept
    expect(wide.y + wide.h).toBe(200);
    const tiny = resizeRect(r, 'se', { x: 100, y: 100 }, bounds, 20, 1);
    expect(tiny).toEqual({ x: 100, y: 100, w: 20, h: 20 });
    const edge = resizeRect(r, 'e', { x: 260, y: 999 }, bounds, 20, 1); // edge acts as its corner
    expect(edge.w).toBeCloseTo(edge.h);
  });

  it('fits a ratio inside a rect, centered', () => {
    expect(fitAspect(fullRect(bounds), 1)).toEqual({ x: 50, y: 0, w: 300, h: 300 });
    expect(fitAspect(fullRect(bounds), 4)).toEqual({ x: 0, y: 100, w: 400, h: 100 });
  });

  it('rounds to whole pixels inside the image', () => {
    expect(pixelRect({ x: 10.4, y: -0.2, w: 100.3, h: 400 }, bounds)).toEqual({ x: 10, y: 0, w: 101, h: 300 });
    expect(pixelRect({ x: 399.9, y: 0, w: 0.1, h: 0.1 }, bounds)).toEqual({ x: 399, y: 0, w: 1, h: 1 });
    expect(sameRect(fullRect(bounds), { x: 0.2, y: 0, w: 399.8, h: 300 })).toBe(true);
    expect(sameRect(fullRect(bounds), { x: 2, y: 0, w: 398, h: 300 })).toBe(false);
  });
});

describe('imageEdit display and output', () => {
  it('shrinks big images for display, never enlarges small ones', () => {
    expect(fitScale({ w: 4000, h: 3000 }, { w: 400, h: 600 })).toBeCloseTo(0.1);
    expect(fitScale({ w: 100, h: 50 }, { w: 400, h: 600 })).toBe(1);
    expect(fitScale({ w: 100, h: 50 }, { w: 0, h: 0 })).toBe(1);
  });

  it('caps the output canvas area', () => {
    expect(outputScale({ w: 4000, h: 3000 })).toBe(1);
    const s = outputScale({ w: 8000, h: 6000 });
    expect(8000 * s * 6000 * s).toBeCloseTo(16_000_000);
  });

  it('keeps JPEG as JPEG, everything else becomes PNG, and names follow', () => {
    expect(outputType('IMG_1.JPG')).toBe('image/jpeg');
    expect(outputType('photo.jpeg')).toBe('image/jpeg');
    expect(outputType('shot.png')).toBe('image/png');
    expect(outputType('anim.webp')).toBe('image/jpeg');
    expect(outputType('IMG_9.HEIC')).toBe('image/jpeg');
    expect(outputType('anim.gif')).toBe('image/png');
    expect(outputType('')).toBe('image/png');
    expect(editedName('shot.png', 'image/png')).toBe('shot.png');
    expect(editedName('IMG_1.JPG', 'image/jpeg')).toBe('IMG_1.JPG');
    expect(editedName('anim.webp', 'image/png')).toBe('anim.png');
    expect(editedName('IMG_9.HEIC', 'image/jpeg')).toBe('IMG_9.jpg');
    expect(editedName('shot.png', 'image/jpeg')).toBe('shot.jpg');
    expect(editedName('noext', 'image/png')).toBe('noext.png');
  });

  it('pen width grows with the image', () => {
    expect(penWidth({ w: 300, h: 200 })).toBe(3);
    expect(penWidth({ w: 1170, h: 2532 })).toBe(10);
    expect(penWidth({ w: 4000, h: 3000 })).toBe(16);
  });
});
