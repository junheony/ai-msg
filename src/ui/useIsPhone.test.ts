// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { PHONE_QUERY, useIsPhone } from './useIsPhone';

/** Enough of a media query engine for PHONE_QUERY: comma = or, `and` = all, max-width / max-height / orientation. */
function evaluate(query: string, w: number, h: number): boolean {
  return query.split(',').some((part) => part.trim().split(/\s+and\s+/).every((f) => {
    const m = /^\(\s*([a-z-]+)\s*:\s*([a-z0-9]+?)(px)?\s*\)$/.exec(f.trim());
    if (!m) throw new Error(`unsupported media feature: ${f}`);
    const [, name, value] = m;
    if (name === 'max-width') return w <= Number(value);
    if (name === 'max-height') return h <= Number(value);
    if (name === 'orientation') return value === (w > h ? 'landscape' : 'portrait');
    throw new Error(`unsupported media feature: ${name}`);
  }));
}

function mockViewport(w: number, h: number) {
  window.matchMedia = ((query: string) => ({
    matches: evaluate(query, w, h), media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe('useIsPhone: a phone on its side is a phone', () => {
  afterEach(() => { cleanup(); (window as { matchMedia?: unknown }).matchMedia = undefined; });

  it.each([
    [844, 390, true], // phone, landscape
    [932, 430, true], // large phone, landscape
    [390, 844, true], // phone, portrait
    [720, 900, true], // the old width edge
    [1024, 768, false], // tablet, landscape: tall enough for the desktop layout
    [1440, 900, false], // desktop
    [800, 501, false], // just over the height edge
  ])('%i×%i → phone %s', (w, h, phone) => {
    mockViewport(w, h);
    expect(renderHook(() => useIsPhone()).result.current).toBe(phone);
  });

  it('styles.css gates the phone layout and the phone toasts on the same query', () => {
    const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');
    expect(css).toContain(`/* ───────── Phone ───────── */\n@media ${PHONE_QUERY} {\n  .topbar`);
    expect(css).toContain(`@media ${PHONE_QUERY} {\n  .toasts { top: auto;`);
  });
});
