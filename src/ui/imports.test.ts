import { describe, expect, it } from 'vitest';
import { codexHandoffExcerpt, grokBotHandoffMessage } from '../shared/handoff';
import type { ServerMessage } from '../shared/protocol';
import type { ProjectEntry, SessionEntry } from '../shared/session-types';
import { deleteBlockedReason } from './components/SessionMenu';
import { grokBotTags, importTitle, rowTag } from './components/Sidebar';
import { grokBotLine } from './components/usageSeats';
import { grokBotHandoffCwd, grokBotRequest, initialState, nextQueued, reducer, type AppState } from './state';

const pane = (s: AppState) => s.panes[0]!;
const play = (msgs: ServerMessage[], start: AppState) => msgs.reduce((s, msg) => reducer(s, { type: 'server', msg }), start);

const e = (over: Partial<SessionEntry>): SessionEntry => ({ sessionId: 'x', account: 'x1', engine: 'grok', cwd: '/w', projectDir: '/p', file: '/f', title: 't', lastModified: 1, sizeBytes: 0, imported: true, ...over });
const proj = (cwd: string, sessions: SessionEntry[]): ProjectEntry => ({ cwd, name: cwd, pinned: false, sessions });

describe('reducer: deck Grok 새 세션으로 이어가기 (grokbot_handoff)', () => {
  // The Grok Bot conversation lives in the home folder '/h'; '/w/new' has the most recent other Grok session, '/w/gone' is
  // gone, '/w/claude' is more recent but has no Grok session.
  const projects = [
    proj('/h', [e({ sessionId: 'grokbot-a', source: 'grokbot', cwd: '/h', lastModified: 9 }), e({ sessionId: 'g-home', imported: false, cwd: '/h', lastModified: 8 })]),
    proj('/w/old', [e({ sessionId: 'c-old', engine: 'claude', imported: false, cwd: '/w/old', lastModified: 2 })]),
    proj('/w/new', [e({ sessionId: 'g-new', imported: false, cwd: '/w/new', lastModified: 5 })]),
    proj('/w/gone', [e({ sessionId: 'g-gone', cwd: '/w/gone', cwdMissing: true, lastModified: 7 })]),
    proj('/w/claude', [e({ sessionId: 'c-claude', engine: 'claude', imported: false, cwd: '/w/claude', lastModified: 6 })]),
  ];
  const opened = (ps: ProjectEntry[] = projects) => {
    const s = reducer({ ...initialState, projects: ps }, { type: 'open', sessionId: 'grokbot-a', cwd: '/h', title: '여행 계획' });
    return play([{ type: 'history', sessionId: 'grokbot-a', cwd: '/h', account: 'x1', engine: 'grok', sandbox: null, runningTurnId: null, messages: [
      { kind: 'user', text: '도쿄 가고 싶어', ts: null },
      { kind: 'assistant', text: '언제 갈까요?', model: null, toolCalls: [], ts: null },
    ] }], s);
  };

  it('opens a new deck Grok session in the most recent non-home Grok session\'s folder with the excerpt prefilled; nothing is sent', () => {
    const before = opened();
    const s = reducer(before, { type: 'grokbot_handoff', paneId: pane(before).id });
    const p = pane(s);
    expect(p.session).toMatchObject({ sessionId: null, cwd: '/w/new', title: '여행 계획 (이어서)', engine: 'grok', sandbox: null });
    expect(p.engine).toBe('grok');
    expect(p.items).toEqual([]);
    expect(p.awaitingStart).toBe(false);
    expect(p.handoffFrom).toEqual({ sessionId: 'grokbot-a', title: '여행 계획', grokBotHome: '/h' });
    const excerpt = codexHandoffExcerpt([{ kind: 'user', text: '도쿄 가고 싶어' }, { kind: 'assistant', text: '언제 갈까요?' }], 'Grok');
    expect(p.prefill).toBe(grokBotHandoffMessage('여행 계획', excerpt));
    expect(p.prefill).toContain('**Grok:** 언제 갈까요?');
  });

  it('never the home folder: no other project leaves the folder empty (the pane asks for one)', () => {
    const before = opened([projects[0]!]);
    expect(pane(reducer(before, { type: 'grokbot_handoff', paneId: pane(before).id })).session?.cwd).toBe('');
    expect(grokBotHandoffCwd([projects[0]!, projects[3]!], '/h')).toBe('');
  });

  it('the folder can be changed before the first send; the home folder and an empty pick are refused, a created session is untouched', () => {
    const before = opened();
    const s = reducer(before, { type: 'grokbot_handoff', paneId: pane(before).id });
    const id = pane(s).id;
    const picked = reducer(s, { type: 'set_new_cwd', cwd: '/w/old', paneId: id });
    expect(pane(picked).session?.cwd).toBe('/w/old');
    expect(pane(picked).prefill).toBe(pane(s).prefill);
    expect(reducer(picked, { type: 'set_new_cwd', cwd: '/h', paneId: id })).toBe(picked);
    expect(reducer(picked, { type: 'set_new_cwd', cwd: '  ', paneId: id })).toBe(picked);
    expect(pane(reducer(before, { type: 'set_new_cwd', cwd: '/w/old', paneId: id })).session?.cwd).toBe('/h');
  });

  it('home rejection survives a reload that drops the `source` tag: an id-only grokbot- entry still marks it, and the pane keeps rejecting its own recorded home even if the reloaded projects list has none', () => {
    // An older roster entry the server never tagged `source: 'grokbot'`: only its id still says what it is.
    const untaggedProjects = [
      proj('/h', [e({ sessionId: 'grokbot-a', cwd: '/h', lastModified: 9 }), e({ sessionId: 'c-home', engine: 'claude', imported: false, cwd: '/h', lastModified: 8 })]),
      proj('/w/new', [e({ sessionId: 'g-new', imported: false, cwd: '/w/new', lastModified: 5 })]),
    ];
    const before = opened(untaggedProjects);
    const s = reducer(before, { type: 'grokbot_handoff', paneId: pane(before).id });
    const id = pane(s).id;
    expect(pane(s).session?.cwd).toBe('/w/new');
    expect(pane(s).handoffFrom).toMatchObject({ grokBotHome: '/h' });
    // Even once the live projects list no longer has any `source: 'grokbot'` (or `grokbot-`) entry at all, the pane's
    // own recorded home from step 1 still refuses it.
    const reloaded = { ...s, projects: [proj('/w/new', untaggedProjects[1]!.sessions)] };
    expect(reducer(reloaded, { type: 'set_new_cwd', cwd: '/h', paneId: id })).toBe(reloaded);
    expect(pane(reducer(reloaded, { type: 'set_new_cwd', cwd: '/w/old', paneId: id })).session?.cwd).toBe('/w/old');
  });

  it('already continued (a session links back to it): no second session — the pane opens that one instead', () => {
    const before = opened([...projects, proj('/w/next', [e({ sessionId: 'g-next', imported: false, cwd: '/w/next', prevSession: 'grokbot-a' })])]);
    expect(reducer(before, { type: 'grokbot_handoff', paneId: pane(before).id })).toBe(before);
  });

  it('not a Grok Bot conversation: unchanged', () => {
    const s = play([{ type: 'history', sessionId: 'X1', cwd: '/w', account: 'x1', engine: 'grok', sandbox: null, runningTurnId: null, messages: [] }], reducer(initialState, { type: 'open', sessionId: 'X1', cwd: '/w', title: 't' }));
    expect(reducer(s, { type: 'grokbot_handoff', paneId: pane(s).id })).toBe(s);
  });
});

describe('reducer: Grok Bot 대화에서 바로 보내기 (grokbot_send)', () => {
  const bot = e({ sessionId: 'grokbot-a', source: 'grokbot', cwd: '/h', lastModified: 9 });
  const work = e({ sessionId: 'g-work', imported: false, cwd: '/w/work', lastModified: 5 });
  const opened = (ps: ProjectEntry[]) => {
    const s = reducer({ ...initialState, projects: ps }, { type: 'open', sessionId: 'grokbot-a', cwd: '/h', title: '여행 계획' });
    return play([{ type: 'history', sessionId: 'grokbot-a', cwd: '/h', account: 'x1', engine: 'grok', sandbox: null, runningTurnId: null, messages: [
      { kind: 'user', text: '도쿄 가고 싶어', ts: null },
      { kind: 'assistant', text: '언제 갈까요?', model: null, toolCalls: [], ts: null },
    ] }], s);
  };
  const first = (text: string) => grokBotHandoffMessage('여행 계획', codexHandoffExcerpt([{ kind: 'user', text: '도쿄 가고 싶어' }, { kind: 'assistant', text: '언제 갈까요?' }], 'Grok')) + text;
  const sendIt = (s: AppState, text = '다음 달에 갈래') => reducer(s, { type: 'grokbot_send', from: 'grokbot-a', text, attachments: [], paneId: pane(s).id });

  it('no continuing session: the pane becomes the new Grok session, its first message (excerpt + text, as the manual flow) queued once', () => {
    const s = sendIt(opened([proj('/h', [bot]), proj('/w/work', [work])]));
    const p = pane(s);
    expect(p.session).toMatchObject({ sessionId: null, cwd: '/w/work', engine: 'grok', title: '여행 계획 (이어서)' });
    expect(p.handoffFrom).toMatchObject({ sessionId: 'grokbot-a' });
    expect(p.queue.map((q) => q.text)).toEqual([first('다음 달에 갈래')]);
    expect(nextQueued(p)?.text).toBe(first('다음 달에 갈래'));
    expect(p.prefill).toBeNull();
  });

  it('a folder picked on the Grok Bot pane wins; the home folder is refused', () => {
    let s = opened([proj('/h', [bot]), proj('/w/work', [work])]);
    expect(reducer(s, { type: 'set_new_cwd', cwd: '/h', paneId: pane(s).id })).toBe(s);
    s = reducer(s, { type: 'set_new_cwd', cwd: '/w/other', paneId: pane(s).id });
    expect(pane(s).session?.sessionId).toBe('grokbot-a');
    expect(pane(sendIt(s)).session?.cwd).toBe('/w/other');
  });

  it('the home folder is never chosen by itself: no other Grok session → the text waits for a folder, then goes out; closing the picker puts it in the composer', () => {
    const homeGrok = e({ sessionId: 'g-home', imported: false, cwd: '/h', lastModified: 8 });
    const s = sendIt(opened([proj('/h', [bot, homeGrok])]));
    const p = pane(s);
    expect(p.session).toMatchObject({ sessionId: null, cwd: '' });
    expect(p.queue).toEqual([]);
    expect(p.grokBotSend?.text).toBe(first('다음 달에 갈래'));
    const picked = pane(reducer(s, { type: 'set_new_cwd', cwd: '/w/pick', paneId: p.id }));
    expect(picked.session?.cwd).toBe('/w/pick');
    expect(picked.grokBotSend).toBeNull();
    expect(picked.queue.map((q) => q.text)).toEqual([first('다음 달에 갈래')]);
    const closed = pane(reducer(s, { type: 'grokbot_send_cancel', paneId: p.id }));
    expect(closed.grokBotSend).toBeNull();
    expect(closed.prefill).toBe(first('다음 달에 갈래'));
    expect(closed.queue).toEqual([]);
  });

  it('already continued: no new session — the text alone (no excerpt again) is queued in the opened continuing session, sent once its history is in', () => {
    const next = e({ sessionId: 'g-next', imported: false, cwd: '/w/next', title: '여행 계획 (이어서)', prevSession: 'grokbot-a' });
    let s = opened([proj('/h', [bot]), proj('/w/next', [next])]);
    // Still on the Grok Bot id (the pane did not open the session): nothing is sent — the text goes back into the composer.
    const kept = pane(sendIt(s));
    expect(kept.session?.sessionId).toBe('grokbot-a');
    expect(kept.queue).toEqual([]);
    expect(kept.prefill).toBe('다음 달에 갈래');
    s = reducer(s, { type: 'open', sessionId: 'g-next', cwd: '/w/next', title: '여행 계획 (이어서)', paneId: pane(s).id });
    s = sendIt(s, '두 번째');
    const p = pane(s);
    expect(p.session?.sessionId).toBe('g-next');
    expect(p.handoffFrom).toBeNull();
    expect(p.queue.map((q) => q.text)).toEqual(['두 번째']);
    expect(nextQueued(p)).toBeNull(); // loading
    s = play([{ type: 'history', sessionId: 'g-next', cwd: '/w/next', account: 'x1', engine: 'grok', sandbox: null, runningTurnId: null, messages: [] }], s);
    expect(nextQueued(pane(s))?.text).toBe('두 번째');
  });

  it('stale link (the list does not show the continuing session, the Grok Bot entry still names it): sent to that session once opened, no new one', () => {
    let s = opened([proj('/h', [{ ...bot, nextSession: 'g-away' }]), proj('/w/work', [work])]);
    s = reducer(s, { type: 'open', sessionId: 'g-away', cwd: '/h', title: '여행 계획', paneId: pane(s).id });
    s = reducer(s, { type: 'grokbot_send', from: 'grokbot-a', to: 'g-away', text: '두 번째', attachments: [], paneId: pane(s).id });
    expect(pane(s).session?.sessionId).toBe('g-away');
    expect(pane(s).queue.map((q) => q.text)).toEqual(['두 번째']);
  });

  it('opening the continuing session fails: the queue stops and the text goes back into the composer', () => {
    let s = opened([proj('/h', [{ ...bot, nextSession: 'g-away' }])]);
    s = reducer(s, { type: 'open', sessionId: 'g-away', cwd: '/h', title: '여행 계획', paneId: pane(s).id });
    s = reducer(s, { type: 'grokbot_send', from: 'grokbot-a', to: 'g-away', text: '두 번째', attachments: [], paneId: pane(s).id });
    s = play([{ type: 'error', turnId: null, sessionId: 'g-away', message: 'not found', code: 'not_found' }], s);
    const p = pane(s);
    expect(p.queue).toEqual([]);
    expect(nextQueued(p)).toBeNull();
    expect(p.prefill).toBe('두 번째');
    expect(p.notices).toHaveLength(1);
  });

  it('sent again before the first send is linked: another pane already started the continuing session — the text goes there, no second session', () => {
    const ps = [proj('/h', [bot]), proj('/w/work', [work])];
    let s = sendIt(opened(ps));
    s = reducer(s, { type: 'add_pane' });
    const second = s.panes[1]!.id;
    s = reducer(s, { type: 'open', sessionId: 'grokbot-a', cwd: '/h', title: '여행 계획', paneId: second });
    s = reducer(s, { type: 'grokbot_send', from: 'grokbot-a', text: '하나 더', attachments: [], paneId: second });
    expect(s.panes[1]!.session?.sessionId).toBe('grokbot-a');
    expect(s.panes[1]!.queue).toEqual([]);
    expect(s.panes[0]!.queue.map((q) => q.text)).toEqual([first('다음 달에 갈래'), '하나 더']);
    expect(s.activePaneId).toBe(s.panes[0]!.id);
  });

  it('the server refuses a second continuing session (grokbot_linked): the bubble goes and the request alone is handed to the session it named', () => {
    let s = sendIt(opened([proj('/h', [bot]), proj('/w/work', [work])]));
    const id = pane(s).id;
    s = reducer(s, { type: 'sent', paneId: id, text: first('다음 달에 갈래'), clientRef: 'r1' });
    s = play([{ type: 'error', turnId: null, clientRef: 'r1', code: 'grokbot_linked', nextSession: 'g-next', message: '이미 이어짐' }], s);
    const p = pane(s);
    expect(p.awaitingRef).toBeNull();
    expect(p.items).toEqual([]);
    expect(p.grokBotGoto).toEqual({ sessionId: 'g-next', from: 'grokbot-a', text: '다음 달에 갈래', attachments: [] });
    expect(s.error).toBeNull();
    expect(grokBotRequest('그냥 글')).toBe('그냥 글');
  });

  it('waiting for a folder, then another session is opened: the request stays with the Grok Bot conversation, back in its composer when reopened', () => {
    const file = { id: 'f1', name: 'a.png', isImage: true, size: 1 };
    let s = reducer(opened([proj('/h', [bot])]), { type: 'grokbot_send', from: 'grokbot-a', text: '다음 달에 갈래', attachments: [file], paneId: 'p0' });
    s = reducer(s, { type: 'open', sessionId: 'X9', cwd: '/w/x', title: 'x', paneId: pane(s).id });
    const moved = pane(s);
    expect(moved.session?.sessionId).toBe('X9');
    expect(moved.grokBotSend).toBeNull();
    expect(moved.queue).toEqual([]);
    expect(moved.prefill).toBeNull();
    expect(moved.attachments).toEqual([]);
    s = reducer(s, { type: 'open', sessionId: 'grokbot-a', cwd: '/h', title: '여행 계획', paneId: pane(s).id });
    expect(pane(s).prefill).toBe('다음 달에 갈래');
    expect(pane(s).attachments).toEqual([file]);
    expect(s.grokBotDrafts).toEqual({});
  });

  it('sent again while another pane holds the unsent continuing session: that pane gets the excerpt + text by the folder rule (never an empty folder)', () => {
    // Folder known: the manual handoff pane (excerpt only in its composer) queues excerpt + text.
    const ps = [proj('/h', [bot]), proj('/w/work', [work])];
    let s = reducer(opened(ps), { type: 'grokbot_handoff', paneId: 'p0' });
    s = reducer(s, { type: 'add_pane' });
    const second = s.panes[1]!.id;
    s = reducer(s, { type: 'open', sessionId: 'grokbot-a', cwd: '/h', title: '여행 계획', paneId: second });
    s = play([{ type: 'history', sessionId: 'grokbot-a', cwd: '/h', account: 'x1', engine: 'grok', sandbox: null, runningTurnId: null, messages: [
      { kind: 'user', text: '도쿄 가고 싶어', ts: null },
      { kind: 'assistant', text: '언제 갈까요?', model: null, toolCalls: [], ts: null },
    ] }], s);
    s = reducer(s, { type: 'grokbot_send', from: 'grokbot-a', text: '하나 더', attachments: [], paneId: second });
    expect(s.panes[0]!.queue.map((q) => q.text)).toEqual([first('하나 더')]);
    expect(s.panes[1]!.queue).toEqual([]);
    expect(s.activePaneId).toBe(s.panes[0]!.id);
    // No folder: the pane waiting for one gets the text added to what waits — nothing queued with an empty cwd.
    let w = sendIt(opened([proj('/h', [bot])]));
    w = reducer(w, { type: 'add_pane' });
    const other = w.panes[1]!.id;
    w = reducer(w, { type: 'open', sessionId: 'grokbot-a', cwd: '/h', title: '여행 계획', paneId: other });
    w = reducer(w, { type: 'grokbot_send', from: 'grokbot-a', text: '하나 더', attachments: [], paneId: other });
    expect(w.panes[0]!.queue).toEqual([]);
    expect(w.panes[0]!.grokBotSend?.text).toBe(`${first('다음 달에 갈래')}\n\n하나 더`);
    expect(nextQueued(w.panes[0]!)).toBeNull();
  });

  it('an error about a session no pane shows leaves other panes loading (their afterLoad messages keep waiting); grokbot_linked shows no error bar', () => {
    let s = opened([proj('/h', [{ ...bot, nextSession: 'g-away' }])]);
    s = reducer(s, { type: 'open', sessionId: 'g-away', cwd: '/h', title: '여행 계획', paneId: pane(s).id });
    s = reducer(s, { type: 'grokbot_send', from: 'grokbot-a', to: 'g-away', text: '두 번째', attachments: [], paneId: pane(s).id });
    s = play([{ type: 'error', turnId: null, sessionId: 'g-raced', code: 'grokbot_linked', nextSession: 'g-away', message: '이미 이어짐' }], s);
    expect(pane(s).loading).toBe(true);
    expect(nextQueued(pane(s))).toBeNull();
    expect(s.error).toBeNull();
  });

  it('waiting for a folder, the home folder is picked (refused): the picker closes and the text goes back into the composer', () => {
    const s = sendIt(opened([proj('/h', [bot])]));
    const p = pane(reducer(s, { type: 'set_new_cwd', cwd: '/h', paneId: pane(s).id }));
    expect(p.session?.cwd).toBe('');
    expect(p.grokBotSend).toBeNull();
    expect(p.queue).toEqual([]);
    expect(p.prefill).toBe(first('다음 달에 갈래'));
  });
});

describe('import rows', () => {
  it('Grok Bot tags: app, awaiting reply, unread, group, read-only', () => {
    expect(grokBotTags(e({ source: 'grokbot', grokBot: { awaitingUserResponse: true, unreadCount: 3, isGroup: true } }))).toEqual(['Grok Bot', '답장 대기', '안 읽음 3', '그룹', '읽기 전용']);
    expect(grokBotTags(e({ source: 'grokbot', grokBot: { awaitingUserResponse: false, unreadCount: 0, isGroup: false } }))).toEqual(['Grok Bot', '읽기 전용']);
    expect(grokBotTags(e({}))).toEqual([]);
  });

  it('the session continuing a Grok Bot conversation carries Grok Bot에서 이어짐', () => {
    expect(rowTag(e({ sessionId: 'g-next', imported: false, prevSession: 'grokbot-a' }))).toBe('Grok Bot에서 이어짐');
    expect(rowTag(e({ sessionId: 'g-next', imported: false, prevSession: 'other' }))).toBeNull();
  });

  it('tooltips per source, with the preview', () => {
    expect(importTitle(e({ source: 'grokbot', preview: '마지막 말' }))).toContain('여기서 보내면 새 Grok 세션으로 이어져요');
    expect(importTitle(e({ source: 'grokbot', preview: '마지막 말' }))).toContain('마지막 말');
    expect(importTitle(e({}))).toContain('Grok CLI');
    expect(importTitle(e({ autoRun: true }))).toContain('헤드리스');
    expect(importTitle(e({ engine: 'gemini', account: 'g1' }))).toContain('agy');
    expect(importTitle(e({ engine: 'codex', account: 'gpt' }))).toContain('Codex');
  });

  it('delete is blocked with the source in the reason', () => {
    expect(deleteBlockedReason(e({ source: 'grokbot' }))).toBe('Grok Bot 앱 기록은 AI-MSG에서 지울 수 없어요');
    expect(deleteBlockedReason(e({}))).toBe('Grok CLI 기록은 AI-MSG에서 지울 수 없어요');
    expect(deleteBlockedReason(e({ engine: 'gemini', account: 'g1' }))).toBe('agy 기록은 AI-MSG에서 지울 수 없어요');
    expect(deleteBlockedReason(e({ engine: 'codex', account: 'gpt' }))).toBe('Codex 앱 기록은 AI-MSG에서 지울 수 없어요');
  });

  it('Grok Bot usage line: plan, percent, reset, and the app sync age past a day', () => {
    const now = Date.UTC(2026, 9, 18, 12);
    expect(grokBotLine({ percentUsed: 41.6, nextResetMs: null, planLabel: 'SuperGrok', readAtMs: now - 3600_000 }, now)).toBe('SuperGrok 58% 남음');
    expect(grokBotLine({ percentUsed: 10, nextResetMs: now + 86_400_000, planLabel: null, readAtMs: now - 30 * 3600_000 }, now)).toMatch(/^플랜 90% 남음 · 리셋 \d+\/\d+ \d\d:\d\d \(앱 동기화 30시간 전\)$/);
  });
});
