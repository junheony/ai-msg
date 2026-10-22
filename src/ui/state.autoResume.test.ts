import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../shared/protocol';
import { initialState, reducer, type AppState } from './state';

const play = (msgs: ServerMessage[], start: AppState = initialState): AppState => msgs.reduce((s, m) => reducer(s, { type: 'server', msg: m }), start);
const opened = (sessionId: string): AppState => reducer(initialState, { type: 'open', sessionId, cwd: '/w', title: 't' });

describe('한도가 풀리면 자동으로 이어가기 (auto_resume)', () => {
  it('a booking is shown per session and a null clears it', () => {
    let s = play([{ type: 'auto_resume', sessionId: 's1', atMs: 1000 }]);
    expect(s.autoResumes?.s1).toBe(1000);
    s = play([{ type: 'auto_resume', sessionId: 's2', atMs: 2000 }, { type: 'auto_resume', sessionId: 's1', atMs: null }], s);
    expect(s.autoResumes).toEqual({ s2: 2000 });
  });

  it('a history carries the booking or its absence', () => {
    const base = { type: 'history' as const, sessionId: 's1', cwd: '/w', account: null, messages: [], runningTurnId: null };
    let s = play([{ ...base, autoResumeAtMs: 5000 }], opened('s1'));
    expect(s.autoResumes?.s1).toBe(5000);
    s = play([base], s);
    expect(s.autoResumes?.s1).toBeUndefined();
  });

  it('the session starting a turn drops its line', () => {
    let s = play([{ type: 'auto_resume', sessionId: 's1', atMs: 1000 }], opened('s1'));
    s = play([{ type: 'turn_started', sessionId: 's1', turnId: 't1' } as ServerMessage], s);
    expect(s.autoResumes?.s1).toBeUndefined();
  });
});
