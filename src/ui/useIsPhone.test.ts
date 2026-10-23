// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { PHONE_QUERY, useIsPhone } from './useIsPhone';

/** Enough of a media query engine for PHONE_QUERY: comma = or, `and` = all, max-width / max-height / orientation / pointer. */
function evaluate(query: string, w: number, h: number, pointer: 'coarse' | 'fine'): boolean {
  return query.split(',').some((part) => part.trim().split(/\s+and\s+/).every((f) => {
    const m = /^\(\s*([a-z-]+)\s*:\s*([a-z0-9]+?)(px)?\s*\)$/.exec(f.trim());
    if (!m) throw new Error(`unsupported media feature: ${f}`);
    const [, name, value] = m;
    if (name === 'max-width') return w <= Number(value);
    if (name === 'max-height') return h <= Number(value);
    if (name === 'orientation') return value === (w > h ? 'landscape' : 'portrait');
    if (name === 'pointer') return value === pointer;
    throw new Error(`unsupported media feature: ${name}`);
  }));
}

function mockViewport(w: number, h: number, pointer: 'coarse' | 'fine') {
  window.matchMedia = ((query: string) => ({
    matches: evaluate(query, w, h, pointer), media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe('useIsPhone: a phone on its side is a phone', () => {
  afterEach(() => { cleanup(); (window as { matchMedia?: unknown }).matchMedia = undefined; });

  it.each([
    [844, 390, 'coarse', true], // phone, landscape
    [932, 430, 'coarse', true], // large phone, landscape
    [890, 510, 'coarse', true], // foldable unfolded, landscape, under the browser's bars
    [390, 844, 'coarse', true], // phone, portrait
    [626, 780, 'coarse', true], // foldable unfolded, portrait
    [466, 678, 'coarse', true], // foldable cover screen
    [720, 900, 'fine', true], // the old width edge
    [1024, 768, 'coarse', false], // tablet, landscape: tall enough for the desktop layout
    [1440, 900, 'fine', false], // desktop
    [1280, 560, 'fine', false], // a short laptop window: a mouse, so not a phone
    [800, 450, 'fine', false], // even a very short one
    [960, 561, 'coarse', false], // just over the height edge
  ] as const)('%i×%i %s → phone %s', (w, h, pointer, phone) => {
    mockViewport(w, h, pointer);
    expect(renderHook(() => useIsPhone()).result.current).toBe(phone);
  });

  it('styles.css gates the phone layout and the phone toasts on the same query', () => {
    const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');
    expect(css).toContain(`/* ───────── Phone ───────── */\n@media ${PHONE_QUERY} {\n  .topbar`);
    expect(css).toContain(`@media ${PHONE_QUERY} {\n  .toasts { top: auto;`);
  });
});
