// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EntitlementRes } from '../../shared/cloud/api-types';
import { formatDateTime, ui } from '../i18n';
import { CloudSection, planText } from './CloudSection';

const NOW = Date.UTC(2026, 9, 26, 12);
const DAY = 86_400_000;
const T = ui().cloud;
const ent = (o: Partial<EntitlementRes>): EntitlementRes => ({ plan: 'none', st: 'none', untilMs: 0, checkedAt: NOW, ...o });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CloudSection plan row', () => {
  it('plan row texts for trial / pro / past_due / canceled / comp / none', () => {
    const d = (ms: number) => formatDateTime(ms, { dateStyle: 'medium' });
    expect(planText(ent({ plan: 'trial', st: 'trialing', untilMs: NOW + 2.5 * DAY }), NOW)).toBe(T.planTrial(3));
    expect(planText(ent({ plan: 'trial', st: 'trialing', untilMs: NOW + 1 }), NOW)).toBe(T.planTrial(1));
    expect(planText(ent({ plan: 'pro', st: 'active', untilMs: NOW + 30 * DAY }), NOW)).toBe(T.planActive);
    expect(planText(ent({ plan: 'pro', st: 'past_due', untilMs: NOW + 7 * DAY }), NOW)).toBe(T.planPastDue(d(NOW + 7 * DAY)));
    expect(planText(ent({ plan: 'pro', st: 'canceled', untilMs: NOW + 9 * DAY }), NOW)).toBe(T.planCanceled(d(NOW + 9 * DAY)));
    expect(planText(ent({ plan: 'comp', st: 'active', untilMs: NOW + 90 * DAY }), NOW)).toBe(T.planComp(d(NOW + 90 * DAY)));
    expect(planText(ent({}), NOW)).toBe(T.planNone);
    // A plan whose time is over reads as Community (the cloud would say none on its next answer).
    expect(planText(ent({ plan: 'pro', st: 'canceled', untilMs: NOW - 1 }), NOW)).toBe(T.planNone);
    expect(planText(ent({ plan: 'trial', st: 'trialing', untilMs: NOW - 1 }), NOW)).toBe(T.planNone);
  });

  it('opening the account group calls plan/refresh once and shows the row; Refresh asks again', async () => {
    const fetchFn = vi.fn(async () => json(ent({ plan: 'pro', st: 'active', untilMs: Date.now() + 30 * DAY })));
    vi.stubGlobal('fetch', fetchFn);
    render(<CloudSection />);
    await screen.findByText(T.planActive);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith('/api/cloud/plan/refresh', expect.objectContaining({ method: 'POST' }));
    expect(screen.getByText(T.proLine, { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: T.refresh }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    await screen.findByRole('button', { name: T.refresh });
  });

  it('not linked (null) or no cloud routes (404): no row', async () => {
    for (const res of [json(null), json({ error: 'not found' }, 404)]) {
      const fetchFn = vi.fn(async () => res);
      vi.stubGlobal('fetch', fetchFn);
      const { container } = render(<CloudSection />);
      await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 0));
      expect(container.querySelector('[data-testid="plan-row"]')).toBeNull();
      cleanup();
    }
  });

  it('relay mode (the phone): read-only from GET status, no refresh call, no button', async () => {
    const fetchFn = vi.fn(async (_url: string) => json({ enabled: true, linked: true, plan: ent({ plan: 'trial', st: 'trialing', untilMs: Date.now() + 5 * DAY }) }));
    vi.stubGlobal('fetch', fetchFn);
    render(<CloudSection readOnly />);
    await screen.findByTestId('plan-row');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]![0]).toBe('/api/cloud/status');
    expect(screen.queryByRole('button', { name: T.refresh })).toBeNull();
  });

  it('구독 관리 opens the app-origin account page on this device', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(ent({ plan: 'pro', st: 'active', untilMs: Date.now() + 30 * DAY }))));
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    render(<CloudSection />);
    fireEvent.click(await screen.findByRole('button', { name: T.manage }));
    // The local server answers 302 → <app origin>/account (src/server/http-cloud.test.ts); the UI holds no cloud address.
    expect(open).toHaveBeenCalledWith('/api/cloud/web/account', '_blank', 'noopener');
    expect(screen.queryByRole('button', { name: T.subscribe })).toBeNull();
  });

  it('after trial: Pro 구독 opens checkout; coming back refreshes the plan once', async () => {
    const fetchFn = vi.fn(async () => json(ent({ plan: 'trial', st: 'trialing', untilMs: Date.now() - DAY })));
    vi.stubGlobal('fetch', fetchFn);
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    render(<CloudSection />);
    fireEvent.click(await screen.findByRole('button', { name: T.subscribe }));
    expect(open).toHaveBeenCalledWith('/api/cloud/web/checkout', '_blank', 'noopener');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const visible = vi.spyOn(document, 'visibilityState', 'get');
    visible.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    visible.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    expect(fetchFn).toHaveBeenLastCalledWith('/api/cloud/plan/refresh', expect.objectContaining({ method: 'POST' }));
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchFn).toHaveBeenCalledTimes(2); // once per trip to the checkout, not on every focus
    visible.mockRestore();
  });

  it('relay mode (the phone): no subscription buttons', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ enabled: true, linked: true, plan: ent({}) })));
    render(<CloudSection readOnly />);
    await screen.findByTestId('plan-row');
    expect(screen.queryByRole('button', { name: T.subscribe })).toBeNull();
    expect(screen.queryByRole('button', { name: T.manage })).toBeNull();
  });
});
