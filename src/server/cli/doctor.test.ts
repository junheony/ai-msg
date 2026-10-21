import { describe, expect, it } from 'vitest';
import type { ClaudeProfileProbe, EngineProbe } from '../../shared/setup-types';
import { formatDoctor } from './doctor';

const engines: EngineProbe[] = [
  { engine: 'claude', bin: '/bin/claude', version: '2.1.283', login: 'no', loginCommand: 'claude auth login' },
  { engine: 'codex', bin: '/bin/codex', version: 'codex-cli 0.159.2', login: 'yes', loginCommand: 'codex login' },
  { engine: 'gemini', bin: '/bin/agy', version: null, login: 'unknown', loginCommand: 'agy', note: '응답 없음(15초)' },
  { engine: 'grok', bin: null, version: null, login: 'unknown', loginCommand: 'grok login', note: 'grok 을 찾지 못했습니다 — DECK_GROK_BIN, PATH, ~/.grok/bin/grok' },
];
const claudeProfiles: ClaudeProfileProbe[] = [
  { id: 'a', label: 'A', dir: '~/.claude', home: true, active: true, login: 'no', loginCommand: 'claude auth login' },
  { id: 'b', label: 'B', dir: '~/.claude-b', home: false, active: false, login: 'yes', loginCommand: 'CLAUDE_CONFIG_DIR=~/.claude-b claude auth login' },
];

describe('formatDoctor', () => {
  const text = formatDoctor({ engines, claudeProfiles });
  const lines = text.split('\n');
  it('one line per engine, then the Claude profiles', () => {
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/claude .*2\.1\.283.*로그인 안 됨.*claude auth login/);
    expect(lines[1]).toMatch(/codex .*0\.159\.2.*로그인됨/);
    expect(lines[1]).not.toMatch(/codex login/);
    expect(lines[2]).toMatch(/gemini.*확인 못 함.*응답 없음/);
    expect(lines[3]).toMatch(/grok .*찾지 못함.*\.grok\/bin\/grok/);
    expect(lines[4]).toMatch(/A.*~\/\.claude .*로그인 안 됨.*claude auth login/);
    expect(lines[5]).toMatch(/B.*~\/\.claude-b.*쉬는 계정.*로그인됨/);
  });
  it('shows where a found binary is', () => expect(lines[0]).toContain('/bin/claude'));
});
