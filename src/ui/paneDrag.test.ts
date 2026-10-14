import { describe, expect, it } from 'vitest';
import { clampFloat, dockSlot, FLOAT_MIN_H, FLOAT_MIN_W, floatRectAt, onRail, RAIL_PX, readFloat, reorderSlot, slotX } from './paneDrag';

describe('paneDrag geometry', () => {
  it('readFloat accepts only a usable box (finite numbers, at least the minimum size) and rounds it', () => {
    expect(readFloat({ x: 1.4, y: 2.6, w: 320.2, h: 240 })).toEqual({ x: 1, y: 3, w: 320, h: 240 });
    expect(readFloat({ x: -50, y: 0, w: 400, h: 300 })).toEqual({ x: -50, y: 0, w: 400, h: 300 });
    expect(readFloat({ x: 0, y: 0, w: FLOAT_MIN_W - 1, h: 300 })).toBeNull();
    expect(readFloat({ x: 0, y: 0, w: 400, h: FLOAT_MIN_H - 1 })).toBeNull();
    expect(readFloat({ x: 0, y: 0, w: 20_000, h: 300 })).toBeNull();
    expect(readFloat({ x: NaN, y: 0, w: 400, h: 300 })).toBeNull();
    expect(readFloat({ x: '0', y: 0, w: 400, h: 300 })).toBeNull();
    expect(readFloat(null)).toBeNull();
    expect(readFloat([1, 2, 3, 4])).toBeNull();
    expect(readFloat('box')).toBeNull();
  });

  it('clampFloat keeps a strip of the card reachable and never lets it exceed the body', () => {
    const bounds = { w: 1200, h: 800 };
    expect(clampFloat({ x: 100, y: 100, w: 400, h: 300 }, bounds)).toEqual({ x: 100, y: 100, w: 400, h: 300 });
    // Dragged far right / down: 120px of width and 48px of height stay on screen.
    expect(clampFloat({ x: 5000, y: 5000, w: 400, h: 300 }, bounds)).toEqual({ x: 1080, y: 752, w: 400, h: 300 });
    // Dragged far left / up: the left and top edges stop at the body (for a card narrower than the body).
    expect(clampFloat({ x: -900, y: -50, w: 400, h: 300 }, bounds)).toEqual({ x: 0, y: 0, w: 400, h: 300 });
    // Too big: shrunk to the body; too small: grown to the minimum.
    expect(clampFloat({ x: 0, y: 0, w: 5000, h: 5000 }, bounds)).toEqual({ x: 0, y: 0, w: 1200, h: 800 });
    expect(clampFloat({ x: 0, y: 0, w: 10, h: 10 }, bounds)).toEqual({ x: 0, y: 0, w: FLOAT_MIN_W, h: FLOAT_MIN_H });
    // A tiny body (narrower than the minimum card): the card keeps its minimum and hangs off the right edge; it may be
    // shifted left (down to its right edge meeting the body's) so the hidden part can be reached.
    expect(clampFloat({ x: 50, y: 0, w: 400, h: 300 }, { w: 200, h: 150 })).toEqual({ x: 50, y: 0, w: 320, h: 240 });
    expect(clampFloat({ x: -500, y: 0, w: 320, h: 240 }, { w: 200, h: 150 })).toEqual({ x: -120, y: 0, w: 320, h: 240 });
  });

  it('floatRectAt hangs a card about as wide as the pane (capped at 560) from the pointer', () => {
    const bounds = { w: 1600, h: 900 };
    // A 400-wide, 800-tall pane: the card is 400 × 640, its grip under the pointer (30% in, 18px down).
    expect(floatRectAt({ x: 700, y: 300 }, { w: 400, h: 800 }, bounds)).toEqual({ x: 580, y: 282, w: 400, h: 640 });
    // A very wide pane is capped; a narrow one grown to the minimum.
    expect(floatRectAt({ x: 700, y: 300 }, { w: 1500, h: 800 }, bounds).w).toBe(560);
    expect(floatRectAt({ x: 700, y: 300 }, { w: 100, h: 100 }, bounds)).toMatchObject({ w: FLOAT_MIN_W, h: FLOAT_MIN_H });
    // Near the edges it is clamped like any card.
    expect(floatRectAt({ x: 5, y: 5 }, { w: 400, h: 800 }, bounds)).toMatchObject({ x: 0, y: 0 });
    // A small body: the card leaves a 24px margin.
    expect(floatRectAt({ x: 100, y: 100 }, { w: 400, h: 800 }, { w: 400, h: 500 })).toMatchObject({ w: 376, h: 476 });
  });

  it('onRail: inside the grid and within RAIL_PX of its top edge', () => {
    const grid = { left: 300, right: 1500, top: 50 };
    expect(onRail({ x: 400, y: 50 }, grid)).toBe(true);
    expect(onRail({ x: 400, y: 50 + RAIL_PX - 1 }, grid)).toBe(true);
    expect(onRail({ x: 400, y: 50 + RAIL_PX }, grid)).toBe(false);
    expect(onRail({ x: 400, y: 40 }, grid)).toBe(false);
    expect(onRail({ x: 299, y: 60 }, grid)).toBe(false);
    expect(onRail({ x: 1501, y: 60 }, grid)).toBe(false);
  });

  it('reorderSlot / dockSlot / slotX: the index a pane lands at and where the marker goes', () => {
    // Three docked panes 400 wide: centres 200, 600, 1000.
    const mids = [200, 600, 1000];
    expect(reorderSlot(mids, 0, 100)).toBe(0);
    expect(reorderSlot(mids, 0, 700)).toBe(1); // past the second pane's centre: between it and the third
    expect(reorderSlot(mids, 0, 1050)).toBe(2);
    expect(reorderSlot(mids, 2, 100)).toBe(0);
    expect(reorderSlot(mids, 2, 900)).toBe(2); // not past its own old neighbours' centres: stays last
    expect(dockSlot(mids, 100)).toBe(0);
    expect(dockSlot(mids, 650)).toBe(2);
    expect(dockSlot(mids, 1200)).toBe(3);
    const rects = [{ left: 0, right: 400 }, { left: 400, right: 800 }, { left: 800, right: 1200 }];
    expect(slotX(rects, 0)).toBe(0);
    expect(slotX(rects, 1)).toBe(400);
    expect(slotX(rects, 3)).toBe(1200); // after the last
    expect(slotX([], 0)).toBe(0);
  });
});
