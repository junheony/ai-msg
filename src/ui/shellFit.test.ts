import { describe, expect, it } from 'vitest';
import { shellShortfall, type ShellMetrics } from './shellFit';

const m = (p: Partial<ShellMetrics> = {}): ShellMetrics => ({ standalone: true, inner: 938, outer: 970, vvHeight: 938, vvScale: 1, safeTop: 32, screen: [1408, 970], ...p });

describe('shellShortfall', () => {
  it('is the status-bar height when a home-screen app is short by exactly that', () => {
    expect(shellShortfall(m())).toBe(32);
    expect(shellShortfall(m({ outer: 971 }))).toBe(33);
    expect(shellShortfall(m({ screen: [970, 1408] }))).toBe(32);
  });
  it('is 0 when the viewport already fills the window, outside a home-screen app, or for any other difference', () => {
    expect(shellShortfall(m({ inner: 970, vvHeight: 970 }))).toBe(0);
    expect(shellShortfall(m({ standalone: false }))).toBe(0);
    expect(shellShortfall(m({ outer: 1010, screen: [1408, 1010] }))).toBe(0);
    expect(shellShortfall(m({ safeTop: 0 }))).toBe(0);
    expect(shellShortfall(m({ outer: 0 }))).toBe(0);
    // a smaller (Stage Manager) window whose difference happens to match
    expect(shellShortfall(m({ inner: 668, outer: 700, vvHeight: 668 }))).toBe(0);
  });
  it('cannot tell with the keyboard up or while zoomed (the last value stays)', () => {
    expect(shellShortfall(m({ vvHeight: 500 }))).toBeNull();
    expect(shellShortfall(m({ vvScale: 1.5 }))).toBeNull();
  });
});
