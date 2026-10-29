// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { WARM_MS, type ContextInfo } from '../context';
import { ContextHint, ContextRing, ContextSheet, contextLevel } from './ContextGauge';

const info = (cacheReadTokens: number, over: Partial<ContextInfo> = {}): ContextInfo =>
  ({ usage: { inputTokens: 2_000, cacheReadTokens, cacheCreationTokens: 10_000 }, window: 1_000_000, at: Date.now(), model: 'opus', account: 'b', ...over });

describe('ContextRing', () => {
  afterEach(cleanup);

  it('a long session is flagged on the ring, a small one is not, ≥85% is high', () => {
    expect(contextLevel(info(300_000))).toEqual({ pct: 31, level: 'long' });
    expect(contextLevel(info(50_000)).level).toBe('ok');
    expect(contextLevel(info(880_000)).level).toBe('high');
    const { getByTestId } = render(<ContextRing info={info(300_000)} />);
    const ring = getByTestId('context-ring');
    expect(ring.getAttribute('class')).toBe('ctx-ring long');
    expect(ring.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('ContextHint', () => {
  afterEach(cleanup);

  it('long session → handoff hint; idle → cache-expired note; otherwise nothing', () => {
    expect(render(<ContextHint info={info(50_000)} />).queryByTestId('context-hint')).toBeNull();
    cleanup();
    expect(render(<ContextHint info={info(400_000)} />).getByTestId('context-hint').textContent).toContain('새 세션으로 넘기면');
    cleanup();
    expect(render(<ContextHint info={info(50_000, { at: Date.now() - WARM_MS - 60_000 })} />).getByTestId('context-hint').textContent).toBe('캐시 만료 · 이번 턴은 전체 다시 읽기');
  });
});

describe('ContextSheet', () => {
  afterEach(cleanup);
  const base = info(300_000);

  it('shows used/limit, known categories, and the last response; hides what was not reported', () => {
    const view = render(<ContextSheet info={{ ...base, categories: [{ id: 'system_prompt', tokens: 12_000 }, { id: 'messages', tokens: 4000 }], last: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300_000, cacheCreationTokens: 10 } }} onClose={() => {}} />);
    expect(view.getByTestId('context-used').textContent).toContain('사용');
    expect(view.getByTestId('context-used').textContent).toContain('한도');
    expect(view.getByTestId('context-categories').textContent).toContain('시스템 프롬프트');
    expect(view.getByTestId('context-categories').textContent).toContain('메시지');
    expect(view.getByTestId('context-categories').textContent).not.toContain('MCP');
    expect(view.getByTestId('context-last').textContent).toContain('출력');
    cleanup();
    const bare = render(<ContextSheet info={base} onClose={() => {}} />);
    expect(bare.getByTestId('context-used')).toBeTruthy();
    expect(bare.queryByTestId('context-categories')).toBeNull();
    expect(bare.queryByTestId('context-last')).toBeNull();
  });

  it('an unmeasured turn hides the fill and the categories and keeps the last response', () => {
    const view = render(<ContextSheet info={{ ...base, measured: false, last: { inputTokens: 8, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 } }} onClose={() => {}} />);
    expect(view.queryByTestId('context-used')).toBeNull();
    expect(view.queryByTestId('context-categories')).toBeNull();
    expect(view.getByTestId('context-last').textContent).toContain('입력');
    expect(view.getByTestId('context-last').textContent).toContain('캐시 쓰기');
  });
});

describe('새 세션으로 이어가기 button', () => {
  afterEach(cleanup);

  it('the long-session hint carries the button; other hints and a missing onHandoff do not', () => {
    let n = 0;
    const long = render(<ContextHint info={info(300_000)} onHandoff={() => { n++; }} />);
    const btn = long.getByTestId('handoff-btn');
    expect(fireEvent.mouseDown(btn)).toBe(false); // default prevented: focus stays where it is
    fireEvent.click(btn);
    expect(n).toBe(1);
    cleanup();
    expect(render(<ContextHint info={info(300_000)} />).queryByTestId('handoff-btn')).toBeNull();
    cleanup();
    const cold = render(<ContextHint info={info(50_000, { at: Date.now() - WARM_MS - 60_000 })} onHandoff={() => {}} />);
    expect(cold.queryByTestId('context-hint')).not.toBeNull();
    expect(cold.queryByTestId('handoff-btn')).toBeNull();
  });
});
