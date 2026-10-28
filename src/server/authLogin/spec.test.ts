import { describe, expect, it } from 'vitest';
import { authChildEnv, authInputLine, authTarget, plainTerminal, scriptInvocation, type AuthAccounts } from './spec';

const accounts = (over: Partial<AuthAccounts> = {}): AuthAccounts => ({
  has: (id) => id === 'a' || id === 'b',
  isRetired: (id) => id === 'old',
  isHome: (id) => id === 'a',
  profileDir: (id) => (id === 'a' ? '/h/.claude' : `/h/.claude-${id}`),
  label: (id) => id.toUpperCase(),
  ...over,
});

const bins = { claude: '/usr/bin/claude', codex: '/usr/bin/codex', grok: '/h/.grok/bin/grok' };

describe('authTarget', () => {
  it('home Claude is claude auth login with no profile env; another seat sets CLAUDE_CONFIG_DIR', () => {
    expect(authTarget('a', accounts(), bins, '/h')).toMatchObject({
      bin: '/usr/bin/claude', args: ['auth', 'login'], label: 'claude auth login', extraEnv: {},
    });
    expect(authTarget('b', accounts(), bins, '/h')).toMatchObject({
      args: ['auth', 'login'],
      label: 'CLAUDE_CONFIG_DIR=~/.claude-b claude auth login',
      extraEnv: { CLAUDE_CONFIG_DIR: '/h/.claude-b' },
    });
  });

  it('codex and grok are their login commands; Gemini and unknown seats are refused', () => {
    expect(authTarget('gpt', accounts(), bins, '/h')).toMatchObject({ bin: '/usr/bin/codex', args: ['login'], label: 'codex login' });
    expect(authTarget('x1', accounts(), bins, '/h')).toMatchObject({ bin: '/h/.grok/bin/grok', args: ['login'], label: 'grok login' });
    expect(authTarget('g1', accounts(), bins, '/h')).toMatchObject({ error: expect.stringContaining('agy') });
    expect(authTarget('nope', accounts(), bins, '/h')).toMatchObject({ error: expect.stringContaining('Claude') });
    expect(authTarget('gpt', accounts(), { ...bins, codex: null }, '/h')).toMatchObject({ error: expect.stringContaining('codex') });
    expect(authTarget('a', accounts(), { ...bins, claude: null }, '/h')).toMatchObject({ error: expect.stringContaining('claude') });
  });

  it('a relative binary is refused', () => {
    expect(authTarget('a', accounts(), { ...bins, claude: 'claude' }, '/h')).toMatchObject({ error: expect.stringContaining('절대') });
  });
});

describe('authInputLine', () => {
  it('a code is one line plus a newline; Enter alone is a newline; a second line or a control character is refused', () => {
    expect(authInputLine({ text: 'AB-CD' })).toEqual({ line: 'AB-CD\n' });
    expect(authInputLine({ text: 'AB-CD\n' })).toEqual({ line: 'AB-CD\n' });
    expect(authInputLine({ enter: true })).toEqual({ line: '\n' });
    expect(authInputLine({ text: 'rm -rf /\nls' })).toMatchObject({ error: expect.stringContaining('한 줄') });
    expect(authInputLine({ text: 'a\u0001b' })).toMatchObject({ error: expect.stringContaining('문자') });
    expect(authInputLine({ text: '' })).toMatchObject({ error: expect.any(String) });
    expect(authInputLine({})).toMatchObject({ error: expect.any(String) });
  });
});

describe('scriptInvocation', () => {
  it('linux quotes the binary into exec; a quote in the path is refused; darwin passes argv', () => {
    expect(scriptInvocation('linux', '/usr/bin/claude', ['auth', 'login'])).toEqual({
      cmd: 'script',
      argv: ['-q', '-e', '-f', '-c', "exec '/usr/bin/claude' 'auth' 'login'", '/dev/null'],
    });
    expect(scriptInvocation('linux', "/opt/My CLIs/claude", ['auth', 'login'])).toEqual({
      cmd: 'script',
      argv: ['-q', '-e', '-f', '-c', "exec '/opt/My CLIs/claude' 'auth' 'login'", '/dev/null'],
    });
    expect(scriptInvocation('linux', "/tmp/claude'; rm", ['auth', 'login'])).toMatchObject({ error: expect.any(String) });
    expect(scriptInvocation('darwin', '/usr/bin/claude', ['auth', 'login'])).toEqual({
      cmd: 'script', argv: ['-q', '/dev/null', '/usr/bin/claude', 'auth', 'login'],
    });
  });
});

describe('plainTerminal and authChildEnv', () => {
  it('strips ANSI and CR, and keeps only the path environment plus the profile', () => {
    expect(plainTerminal('\u001b[31mhttps://x.test/c\u001b[0m\r\n')).toBe('https://x.test/c\n');
    const env = authChildEnv({ PATH: '/bin', HOME: '/h', DECK_TOKEN: 'secret', LC_ALL: 'C', CLAUDE_CONFIG_DIR: '/other' }, { CLAUDE_CONFIG_DIR: '/h/.claude-b' });
    expect(env.PATH).toBe('/bin');
    expect(env.HOME).toBe('/h');
    expect(env.LC_ALL).toBe('C');
    expect(env.TERM).toBe('xterm-256color');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/h/.claude-b');
    expect(env.DECK_TOKEN).toBeUndefined();
  });
});
