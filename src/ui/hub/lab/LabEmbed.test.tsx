// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { HUB_MODES, modeAt, modeDigit } from '../modes';
import { HubRail } from '../HubRail';
import { LAB_PROBE_OK_MS, LabEmbed, probeLab, type LabProbe } from './LabEmbed';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('연구소 in the rail', () => {
  it('is the last entry, with no shortcut; the entries before it keep their place and digit', () => {
    expect(HUB_MODES.map((m) => m.id)).toEqual(['home', 'msg', 'nexus', 'trading', 'video', 'game', 'ops', 'updown', 'quant', 'yapping', 'research', 'lab']);
    expect(HUB_MODES[11]).toMatchObject({ label: '연구소', icon: 'flask' });
    expect(HUB_MODES.map((_, i) => modeDigit(i))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 0, null, null]);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map(modeAt)).toEqual(HUB_MODES.slice(0, 10).map((m) => m.id));
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map(modeAt)).not.toContain('lab');
  });
  it('shows up with an icon, no state dot and no key hint, and selects', () => {
    const onChange = vi.fn();
    render(<HubRail mode="msg" status={null} onChange={onChange} mac />);
    const btn = screen.getByRole('button', { name: '연구소' });
    expect(btn.getAttribute('title')).toBe('연구소');
    expect(btn.querySelector('svg path')).toBeTruthy();
    expect(btn.querySelector('.hub-dot')).toBeNull();
    fireEvent.click(btn);
    expect(onChange).toHaveBeenCalledWith('lab');
    expect(screen.getByRole('button', { name: '야핑봇' }).getAttribute('title')).toBe('야핑봇 (⌘0)');
  });
});

describe('LabEmbed', () => {
  it('shows the frame on the relay once the gateway answers', async () => {
    render(<LabEmbed probe={async () => 'ok'} />);
    expect(screen.getByTestId('lab-embed-off').textContent).toContain('확인 중');
    expect(document.querySelector('iframe')).toBeNull();
    await settle();
    const frame = document.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe('/lab');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    const open = screen.getByRole('link', { name: /새 창에서 열기/ });
    expect(open.getAttribute('href')).toBe('/lab');
    expect(open.getAttribute('target')).toBe('_blank');
  });
  it('follows inner navigation without reloading the frame; a reload or an outage returns to that page', async () => {
    const arriveAt = (pathname: string, search = '') => {
      const frame = document.querySelector('iframe')!;
      Object.defineProperty(frame, 'contentWindow', { configurable: true, value: { location: { pathname, search } } });
      fireEvent.load(frame);
    };
    const link = () => screen.getByRole('link', { name: /새 창에서 열기/ }).getAttribute('href');
    vi.useFakeTimers();
    let answer: LabProbe = 'ok';
    render(<LabEmbed probe={async () => answer} />);
    await settle();
    const first = document.querySelector('iframe')!;
    arriveAt('/lab/oi', '?x=1');
    expect(link()).toBe('/lab/oi?x=1');
    expect(document.querySelector('iframe')).toBe(first);
    expect(first.getAttribute('src')).toBe('/lab');
    fireEvent.click(screen.getByRole('button', { name: /새로고침/ }));
    expect(document.querySelector('iframe')).not.toBe(first);
    expect(document.querySelector('iframe')!.getAttribute('src')).toBe('/lab/oi?x=1');
    arriveAt('/lab/live');
    answer = 'login';
    await act(async () => { await vi.advanceTimersByTimeAsync(LAB_PROBE_OK_MS); });
    expect(document.querySelector('iframe')).toBeNull();
    answer = 'ok';
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(document.querySelector('iframe')!.getAttribute('src')).toBe('/lab/live');
  });
  it('shows a sentence and a retry button, not an empty frame, when it is down; the retry recovers', async () => {
    let answer: LabProbe = 'offline';
    render(<LabEmbed probe={async () => answer} />);
    await settle();
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('연구소 서버에 연결할 수 없습니다 — cblabx-labgw 상태 확인');
    answer = 'ok';
    fireEvent.click(screen.getByRole('button', { name: /다시 시도/ }));
    await settle();
    expect(document.querySelector('iframe')).toBeTruthy();
  });
  it('says so when the session has lapsed, rather than blaming the gateway', async () => {
    render(<LabEmbed probe={async () => 'login'} />);
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('로그인이 필요합니다');
  });
  it('survives one missed probe, and goes offline on the second', async () => {
    vi.useFakeTimers();
    let answer: LabProbe = 'ok';
    render(<LabEmbed probe={async () => answer} />);
    await settle();
    answer = 'offline';
    await act(async () => { await vi.advanceTimersByTimeAsync(LAB_PROBE_OK_MS); });
    expect(document.querySelector('iframe')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(LAB_PROBE_OK_MS); });
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
  });
  it('keeps polling after an outage and comes back on its own', async () => {
    vi.useFakeTimers();
    let answer: LabProbe = 'offline';
    render(<LabEmbed probe={async () => answer} />);
    await settle();
    answer = 'ok';
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(document.querySelector('iframe')).toBeTruthy();
  });
});

describe('probeLab', () => {
  const answer = (v: Response | Error) => vi.stubGlobal('fetch', vi.fn(async () => { if (v instanceof Error) throw v; return v; }));
  it('reads the relay: 200 ok, 401 login, 503 or no answer offline', async () => {
    answer(new Response('{}', { status: 200 })); expect(await probeLab()).toBe('ok');
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/lab/health');
    answer(new Response('{}', { status: 401 })); expect(await probeLab()).toBe('login');
    answer(new Response('{}', { status: 503 })); expect(await probeLab()).toBe('offline');
    answer(new TypeError('fetch failed')); expect(await probeLab()).toBe('offline');
  });
});

describe('service worker', () => {
  it('leaves the relay alone: a lab page in a frame must never replace the cached app shell', () => {
    const listeners: Record<string, (e: unknown) => void> = {};
    const self = { addEventListener: (n: string, f: (e: unknown) => void) => { listeners[n] = f; }, location: { origin: 'https://h' }, skipWaiting() {}, clients: {}, registration: {} };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../public/sw.js'), 'utf8'), { self, URL, Response, caches: { match: async () => undefined, open: async () => ({}) }, fetch: () => Promise.reject(new Error('no')) });
    const taken = (pathname: string) => {
      const respondWith = vi.fn();
      listeners.fetch!({ request: { method: 'GET', url: `https://h${pathname}`, mode: 'navigate' }, respondWith });
      return respondWith.mock.calls.length > 0;
    };
    expect(taken('/')).toBe(true);
    expect(taken('/laboratory')).toBe(true);
    for (const p of ['/lab', '/lab/', '/lab/live', '/lab/static/ui_theme_v1/chrome.js']) expect(taken(p)).toBe(false);
  });
});
