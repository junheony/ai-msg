// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MessageView } from './MessageView';
import { isStoppedTurn } from './TurnBadge';

const mk = (inputTokens: number, outputTokens: number, cacheReadTokens = 0) =>
  ({ account: 'b', model: 'opus', reason: '가장 여유', modelNote: null, usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens: 0 } }) as never;

const turn = (badge: never, extra: { text?: string; error?: string | null; streaming?: boolean } = {}) =>
  ({ kind: 'assistant' as const, turnId: 't', text: extra.text ?? '', toolCalls: [], badge, streaming: extra.streaming ?? false, error: extra.error ?? null, notes: [], attempts: [] });

describe('isStoppedTurn', () => {
  it('zero input and zero output tokens is a stopped turn', () => {
    expect(isStoppedTurn({ badge: mk(0, 0) })).toBe(true);
    expect(isStoppedTurn({ badge: mk(0, 0, 5000), text: 'x' })).toBe(true);
  });
  it('the server interrupt error (중단됨) or an abort/interrupt message is stopped even with tokens', () => {
    expect(isStoppedTurn({ badge: mk(10, 5), error: '중단됨', text: 'partial' })).toBe(true);
    expect(isStoppedTurn({ badge: mk(10, 5), error: 'Request was aborted.', text: 'p' })).toBe(true);
    expect(isStoppedTurn({ badge: mk(10, 5), error: 'interrupted by user', text: 'p' })).toBe(true);
  });
  it('an error with no output text and no output tokens is stopped; a normal turn is not', () => {
    expect(isStoppedTurn({ badge: mk(1200, 0), error: '한도 초과', text: '' })).toBe(true);
    expect(isStoppedTurn({ badge: mk(1200, 40), error: '한도 초과', text: 'half an answer' })).toBe(false);
    expect(isStoppedTurn({ badge: mk(1200, 340), text: 'ok' })).toBe(false);
  });
});

describe('TurnBadge stopped rendering', () => {
  afterEach(cleanup);

  it('a zero-token turn shows 중단됨 instead of 입력 0 · 출력 0, keeping account, model and reason', () => {
    const { container } = render(<MessageView item={turn(mk(0, 0))} />);
    const b = container.querySelector('.turn-badge')!;
    expect(b.classList.contains('stopped')).toBe(true);
    expect(b.querySelector('.tb-stopped')?.textContent).toBe('중단됨');
    expect(b.textContent).not.toContain('입력 0');
    for (const s of ['B', '가장 여유']) expect(b.textContent).toContain(s);
    expect(b.querySelector('.tb-stopped')?.getAttribute('title')).toContain('입력 0');
  });

  it('an interrupted turn does not repeat "오류: 중단됨" under the pill', () => {
    const { container } = render(<MessageView item={turn(mk(0, 0), { error: '중단됨' })} />);
    expect(container.querySelector('.error')).toBeNull();
    expect(container.querySelector('.tb-stopped')).not.toBeNull();
  });

  it('a real error keeps its error line; a normal turn shows token counts', () => {
    const e = render(<MessageView item={turn(mk(0, 0), { error: '엔진이 결과 없이 종료했습니다' })} />);
    expect(e.container.querySelector('.error')?.textContent).toContain('엔진이 결과 없이');
    cleanup();
    const { container } = render(<MessageView item={turn(mk(1200, 340), { text: 'ok' })} />);
    expect(container.querySelector('.tb-stopped')).toBeNull();
    expect(container.querySelector('.tb-tokens')?.textContent).toContain('입력 1.2k');
  });
});
