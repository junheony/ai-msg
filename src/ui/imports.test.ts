import { describe, expect, it } from 'vitest';
import { codexHandoffExcerpt, grokBotHandoffMessage } from '../shared/handoff';
import type { ServerMessage } from '../shared/protocol';
import type { SessionEntry } from '../shared/session-types';
import { deleteBlockedReason } from './components/SessionMenu';
import { grokBotTags, importTitle } from './components/Sidebar';
import { grokBotLine } from './components/UsagePanel';
import { initialState, reducer, type AppState } from './state';

const pane = (s: AppState) => s.panes[0]!;
const play = (msgs: ServerMessage[], start: AppState) => msgs.reduce((s, msg) => reducer(s, { type: 'server', msg }), start);

describe('reducer: deck Grok 새 세션으로 이어가기 (grokbot_handoff)', () => {
  const opened = () => {
    const s = reducer(initialState, { type: 'open', sessionId: 'grokbot-a', cwd: '/h', title: '여행 계획' });
    return play([{ type: 'history', sessionId: 'grokbot-a', cwd: '/h', account: 'x1', engine: 'grok', sandbox: null, runningTurnId: null, messages: [
      { kind: 'user', text: '도쿄 가고 싶어', ts: null },
      { kind: 'assistant', text: '언제 갈까요?', model: null, toolCalls: [], ts: null },
    ] }], s);
  };

  it('opens a new deck Grok session in the same folder with the excerpt prefilled; nothing is sent', () => {
    const before = opened();
    const s = reducer(before, { type: 'grokbot_handoff', paneId: pane(before).id });
    const p = pane(s);
    expect(p.session).toMatchObject({ sessionId: null, cwd: '/h', title: '여행 계획 (이어서)', engine: 'grok', sandbox: null });
    expect(p.engine).toBe('grok');
    expect(p.items).toEqual([]);
    expect(p.awaitingStart).toBe(false);
    expect(p.handoffFrom).toEqual({ sessionId: 'grokbot-a', title: '여행 계획' });
    const excerpt = codexHandoffExcerpt([{ kind: 'user', text: '도쿄 가고 싶어' }, { kind: 'assistant', text: '언제 갈까요?' }], 'Grok');
    expect(p.prefill).toBe(grokBotHandoffMessage('여행 계획', excerpt));
    expect(p.prefill).toContain('**Grok:** 언제 갈까요?');
  });

  it('not a Grok Bot conversation: unchanged', () => {
    const s = play([{ type: 'history', sessionId: 'X1', cwd: '/w', account: 'x1', engine: 'grok', sandbox: null, runningTurnId: null, messages: [] }], reducer(initialState, { type: 'open', sessionId: 'X1', cwd: '/w', title: 't' }));
    expect(reducer(s, { type: 'grokbot_handoff', paneId: pane(s).id })).toBe(s);
  });
});

const e = (over: Partial<SessionEntry>): SessionEntry => ({ sessionId: 'x', account: 'x1', engine: 'grok', cwd: '/w', projectDir: '/p', file: '/f', title: 't', lastModified: 1, sizeBytes: 0, imported: true, ...over });

describe('import rows', () => {
  it('Grok Bot tags: app, awaiting reply, unread, group, read-only', () => {
    expect(grokBotTags(e({ source: 'grokbot', grokBot: { awaitingUserResponse: true, unreadCount: 3, isGroup: true } }))).toEqual(['Grok Bot', '답장 대기', '안 읽음 3', '그룹', '읽기 전용']);
    expect(grokBotTags(e({ source: 'grokbot', grokBot: { awaitingUserResponse: false, unreadCount: 0, isGroup: false } }))).toEqual(['Grok Bot', '읽기 전용']);
    expect(grokBotTags(e({}))).toEqual([]);
  });

  it('tooltips per source, with the preview', () => {
    expect(importTitle(e({ source: 'grokbot', preview: '마지막 말' }))).toContain('Grok Bot 앱에서 이어가세요');
    expect(importTitle(e({ source: 'grokbot', preview: '마지막 말' }))).toContain('마지막 말');
    expect(importTitle(e({}))).toContain('Grok CLI');
    expect(importTitle(e({ autoRun: true }))).toContain('헤드리스');
    expect(importTitle(e({ engine: 'gemini', account: 'g1' }))).toContain('agy');
    expect(importTitle(e({ engine: 'codex', account: 'gpt' }))).toContain('Codex');
  });

  it('delete is blocked with the source in the reason', () => {
    expect(deleteBlockedReason(e({ source: 'grokbot' }))).toBe('Grok Bot 앱 기록은 deck에서 지울 수 없어요');
    expect(deleteBlockedReason(e({}))).toBe('Grok CLI 기록은 deck에서 지울 수 없어요');
    expect(deleteBlockedReason(e({ engine: 'gemini', account: 'g1' }))).toBe('agy 기록은 deck에서 지울 수 없어요');
    expect(deleteBlockedReason(e({ engine: 'codex', account: 'gpt' }))).toBe('Codex 앱 기록은 deck에서 지울 수 없어요');
  });

  it('Grok Bot usage line: plan, percent, reset, and the app sync age past a day', () => {
    const now = Date.UTC(2026, 9, 18, 12);
    expect(grokBotLine({ percentUsed: 41.6, nextResetMs: null, planLabel: 'SuperGrok', readAtMs: now - 3600_000 }, now)).toBe('SuperGrok 42% 사용');
    expect(grokBotLine({ percentUsed: 10, nextResetMs: now + 86_400_000, planLabel: null, readAtMs: now - 30 * 3600_000 }, now)).toMatch(/^플랜 10% 사용 · 리셋 \d+\/\d+ \d\d:\d\d \(앱 동기화 30시간 전\)$/);
  });
});
