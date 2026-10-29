import { describe, expect, it, vi } from 'vitest';
import { AuthLoginHub, type AuthPty } from './hub';
import type { AuthAccounts } from './spec';

const accounts: AuthAccounts = {
  has: (id) => id === 'a' || id === 'b',
  isRetired: () => false,
  isHome: (id) => id === 'a',
  profileDir: (id) => (id === 'a' ? '/h/.claude' : `/h/.claude-${id}`),
  label: (id) => id.toUpperCase(),
};

class FakePty implements AuthPty {
  written = '';
  killed = false;
  private data: ((s: string) => void) | null = null;
  private exit: ((c: number | null) => void) | null = null;
  write(text: string): void { this.written += text; }
  kill(): void { this.killed = true; this.exit?.(null); }
  onData(cb: (text: string) => void): void { this.data = cb; }
  onExit(cb: (code: number | null) => void): void { this.exit = cb; }
  emit(text: string): void { this.data?.(text); }
  done(code: number | null): void { this.exit?.(code); }
}

function hub(spawn: (pty: FakePty) => void = () => {}) {
  let pty: FakePty | null = null;
  const h = new AuthLoginHub({
    accounts, home: '/h', bins: { claude: '/usr/bin/claude', codex: '/usr/bin/codex', grok: null, gemini: null },
    baseEnv: { PATH: '/bin', HOME: '/h', DECK_TOKEN: 'nope' },
    spawn: (spec) => {
      pty = new FakePty();
      expect(spec.bin).toBe('/usr/bin/claude');
      expect(spec.args).toEqual(['auth', 'login']);
      expect(spec.env.DECK_TOKEN).toBeUndefined();
      spawn(pty);
      return pty;
    },
  });
  return { h, pty: () => pty! };
}

describe('AuthLoginHub', () => {
  it('starts only the allowlisted command, writes the pasted code as stdin, and streams the URL', () => {
    const { h, pty } = hub();
    const started = h.start('b');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.label).toContain('CLAUDE_CONFIG_DIR=~/.claude-b');
    expect(pty().written).toBe('');
    const events: string[] = [];
    expect(h.subscribe(started.id, (ev) => events.push(ev.type === 'out' ? ev.text : ev.type)).ok).toBe(true);
    pty().emit('\u001b[32mhttps://claude.ai/login\u001b[0m\r\n');
    expect(events.join('')).toContain('https://claude.ai/login');
    expect(h.write(started.id, 'AB-CD\n')).toEqual({ ok: true });
    expect(pty().written).toBe('AB-CD\n');
    expect(h.start('a')).toMatchObject({ ok: false, status: 409 });
    pty().done(0);
    expect(events).toContain('exit');
    expect(pty().killed).toBe(false);
  });

  it('cancel kills the process; a later write is refused', () => {
    const { h, pty } = hub();
    const started = h.start('a');
    if (!started.ok) throw new Error('start');
    expect(h.cancel(started.id)).toBe(true);
    expect(pty().killed).toBe(true);
    expect(h.write(started.id, 'x\n').ok).toBe(false);
  });

  it('refuses a seat with no binary and an input that is not a single code line', () => {
    const { h } = hub();
    expect(h.start('x1')).toMatchObject({ ok: false, status: 400 });
    const started = h.start('a');
    if (!started.ok) throw new Error('start');
    expect(h.write(started.id, 'one\ntwo\n')).toMatchObject({ ok: false });
  });

  it('a spawn failure is a 400 and does not hold the window', () => {
    const h = new AuthLoginHub({
      accounts, home: '/h', bins: { claude: '/usr/bin/claude', codex: null, grok: null, gemini: null }, baseEnv: { PATH: '/bin', HOME: '/h' },
      spawn: () => { throw new Error('이 호스트에 script 명령이 없어 로그인 창을 열 수 없습니다'); },
    });
    expect(h.start('a')).toEqual({ ok: false, status: 400, error: '이 호스트에 script 명령이 없어 로그인 창을 열 수 없습니다' });
    expect(h.start('a').ok).toBe(false);
  });

  it('a login that exits on its own notifies onExit; cancel and the timeout do not', () => {
    const exits: Array<[string, number | null]> = [];
    let pty: FakePty | null = null;
    const h = new AuthLoginHub({
      accounts, home: '/h', bins: { claude: null, codex: null, grok: '/h/.grok/bin/grok', gemini: null },
      baseEnv: { PATH: '/bin', HOME: '/h' },
      spawn: () => { pty = new FakePty(); return pty; },
      onExit: (seat, code) => exits.push([seat, code]),
    });
    const started = h.start('x1');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    pty!.done(0);
    expect(exits).toEqual([['x1', 0]]);
    const failed = h.start('x1');
    if (!failed.ok) throw new Error('start');
    pty!.done(1);
    expect(exits).toEqual([['x1', 0], ['x1', 1]]);
    const cancelled = h.start('x1');
    if (!cancelled.ok) throw new Error('start');
    expect(h.cancel(cancelled.id)).toBe(true);
    expect(exits).toEqual([['x1', 0], ['x1', 1]]);
  });

  it('the window closes itself after 10 minutes', () => {
    vi.useFakeTimers();
    const { h, pty } = hub();
    const started = h.start('a');
    if (!started.ok) throw new Error('start');
    const events: string[] = [];
    h.subscribe(started.id, (ev) => events.push(ev.type === 'error' ? ev.message : ev.type));
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(pty().killed).toBe(true);
    expect(events.some((e) => e.includes('시간'))).toBe(true);
    vi.useRealTimers();
  });
});
