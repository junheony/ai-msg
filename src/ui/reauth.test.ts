import { describe, expect, it } from 'vitest';
import type { SetupStatus } from '../shared/setup-types';
import { reauthSeats } from './reauth';

const status = (over: Partial<SetupStatus> = {}): SetupStatus => ({
  engines: [
    { engine: 'claude', bin: '/bin/claude', version: '1', login: 'yes', loginCommand: 'claude auth login' },
    { engine: 'codex', bin: '/bin/codex', version: '1', login: 'no', loginCommand: 'codex login' },
    { engine: 'gemini', bin: '/bin/agy', version: '1', login: 'no', loginCommand: 'agy' },
    { engine: 'grok', bin: null, version: null, login: 'no', loginCommand: 'grok login' },
  ],
  claudeProfiles: [
    { id: 'a', label: 'A', dir: '~/.claude', home: true, active: true, login: 'yes', loginCommand: 'claude auth login' },
    { id: 'b', label: 'B', dir: '~/.claude-b', home: false, active: true, login: 'no', loginCommand: 'CLAUDE_CONFIG_DIR=~/.claude-b claude auth login' },
    { id: 'c', label: 'C', dir: '~/.claude-c', home: false, active: false, login: 'no', loginCommand: 'CLAUDE_CONFIG_DIR=~/.claude-c claude auth login' },
  ],
  addresses: [], needed: false, supervised: false, restartNeeded: false, accountsFile: true, checkedAt: 't',
  ...over,
});

describe('reauthSeats', () => {
  it('lists logged-out Claude profiles and Codex; skips Gemini, a missing grok binary and a retired profile', () => {
    expect(reauthSeats(status())).toEqual(['b', 'gpt']);
  });
});
