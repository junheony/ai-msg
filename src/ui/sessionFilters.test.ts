import { describe, expect, it } from 'vitest';
import { isAutomatedSession } from './sessionFilters';

describe('isAutomatedSession', () => {
  it('is a Codex exec or a Grok headless run, and nothing else', () => {
    expect(isAutomatedSession({ codexExec: true })).toBe(true);
    expect(isAutomatedSession({ autoRun: true })).toBe(true);
    expect(isAutomatedSession({})).toBe(false);
    expect(isAutomatedSession({ codexExec: false, autoRun: false })).toBe(false);
  });
});
