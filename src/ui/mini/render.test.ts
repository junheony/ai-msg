import { describe, expect, it } from 'vitest';
import type { MiniStatus } from '../../shared/mini-types';
import { ago, countdown, fmtCost, fmtTokens, forText } from './format';
import { MINI_TEXTS, leftTone, pctTone, renderHead, renderLogin, renderStatus } from './render';

const NOW = Date.parse('2026-10-30T12:00:00Z');

const status: MiniStatus = {
  running: 1,
  waiting: 1,
  sessions: [
    { title: 'deck <b>x</b>', engine: 'claude', model: 'claude-opus-4-1', account: 'a', contextPct: 87, context: 174_000, out: 12_345, cacheRead: 1_500_000, costUsd: 1.234, turns: 7, lastPrompt: '"quote" & <tag>', state: 'waiting', updatedAgoMs: 3000, forMs: 65_000 },
    { title: 'quant', engine: 'codex', model: 'gpt-5', account: 'gpt', contextPct: null, context: null, out: 0, cacheRead: 0, costUsd: null, turns: 1, lastPrompt: '', state: 'running', updatedAgoMs: 120_000, forMs: 10_000 },
  ],
  seats: [
    { id: 'a', label: 'A', status: 'ok', left5h: 8, leftWeek: 40, resets5h: new Date(NOW + 130 * 60_000).toISOString(), resetsWeek: new Date(NOW + 50 * 3600_000).toISOString() },
    { id: 'gpt', label: 'GPT', status: 'down', left5h: null, leftWeek: null, resets5h: null, resetsWeek: null },
  ],
  hub: { modes: [{ id: 'quant', name: 'Quant', state: 'down' }, { id: 'news', name: 'News', state: 'ok' }], counts: { ok: 1, down: 1, warn: 0, idle: 0, unknown: 0 }, worst: 'down', generated_at: new Date(NOW).toISOString() },
  generated_at: new Date(NOW).toISOString(),
};

describe('mini format', () => {
  it('tokens, cost, times', () => {
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(12_345)).toBe('12k');
    expect(fmtTokens(1_500_000)).toBe('1.5M');
    expect(fmtCost(null)).toBe('—');
    expect(fmtCost(0.004)).toBe('<$0.01');
    expect(fmtCost(1.234)).toBe('$1.23');
    expect(ago(2000)).toBe('방금');
    expect(ago(45_000)).toBe('45초 전');
    expect(ago(3_600_000 * 5)).toBe('5시간 전');
    expect(forText(65_000)).toBe('1분');
    expect(forText(3_900_000)).toBe('1시간 5분');
    expect(countdown(null, NOW)).toBe('—');
    expect(countdown(new Date(NOW + 130 * 60_000).toISOString(), NOW)).toBe('2h 10m');
    expect(countdown(new Date(NOW + 50 * 3600_000).toISOString(), NOW)).toBe('2d 2h');
    expect(countdown(new Date(NOW - 1000).toISOString(), NOW)).toBe('지남');
  });
  it('tones', () => {
    expect(pctTone(null)).toBe('none'); expect(pctTone(10)).toBe('ok'); expect(pctTone(60)).toBe('warn'); expect(pctTone(87)).toBe('danger');
    expect(leftTone(null)).toBe('none'); expect(leftTone(50)).toBe('ok'); expect(leftTone(20)).toBe('warn'); expect(leftTone(8)).toBe('danger');
  });
});

describe('renderStatus', () => {
  const html = renderStatus(status, NOW);
  it('shows every session with its big numbers and escapes text', () => {
    expect(html).toContain('deck &lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&quot;quote&quot; &amp; &lt;tag&gt;');
    expect(html).toContain('class="big danger"');
    expect(html).toContain('<span class="num">87</span>');
    expect(html).toContain('aria-valuenow="87"');
    expect(html).toContain('>12k<');
    expect(html).toContain('>1.5M<');
    expect(html).toContain('>$1.23<');
    expect(html).toContain(MINI_TEXTS.waiting);
    expect(html).toContain('1분 째');
    // the GPT session: no context number, no cost, running for 10 s
    expect(html).toContain('class="big none"');
    expect(html).toContain('10초 째');
    expect(html).toContain('claude-opus-4-1 · a');
  });
  it('seats and hub', () => {
    expect(html).toContain('class="seat-cell danger"><span class="num">8</span>');
    expect(html).toContain('5시간 · 2h 10m');
    expect(html).toContain('주간 · 2d 2h');
    expect(html).toContain('class="seat down"');
    expect(html).toContain('class="chip danger" title="down">Quant</span>');
    expect(html).toContain('class="chip ok" title="ok">News</span>');
    expect(html).toContain('<span class="count danger">down</span>');
    expect(html).toContain('ok 1 · down 1');
  });
  it('empty state and login', () => {
    const empty = renderStatus({ ...status, running: 0, waiting: 0, sessions: [], seats: [], hub: null }, NOW);
    expect(empty).toContain(MINI_TEXTS.noSessions);
    expect(empty).toContain('<span class="count none">unknown</span>');
    expect(renderLogin()).toContain('href="/"');
  });
  it('head: badge, staleness, error', () => {
    expect(renderHead(status, NOW - 3000, NOW, null)).toContain('badge warn">1 승인 대기');
    expect(renderHead({ ...status, waiting: 0 }, NOW - 3000, NOW, null)).toContain('badge ok">1 실행 중');
    expect(renderHead(status, NOW - 90_000, NOW, null)).toContain('오래된 정보');
    expect(renderHead(null, null, NOW, '<x>')).toContain('class="err">&lt;x&gt;');
    expect(renderHead(null, null, NOW, null)).toContain('class="refresh"');
  });
});
