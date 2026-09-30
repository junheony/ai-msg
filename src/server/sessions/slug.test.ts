import { describe, expect, it } from 'vitest';
import { projectSlug } from './slug';

describe('projectSlug', () => {
  it('replaces every non-alphanumeric character with a dash (per code point)', () => {
    expect(projectSlug('/Users/max/Documents/개발/agentic-harness')).toBe('-Users-max-Documents----agentic-harness');
    expect(projectSlug('/Users/max/Documents/개발/StandX_volume')).toBe('-Users-max-Documents----StandX-volume');
    expect(projectSlug('/private/tmp/claude-501/sdk-spike/work')).toBe('-private-tmp-claude-501-sdk-spike-work');
    expect(projectSlug('/Users/max/Documents/개발/agentic-harness'.normalize('NFD'))).toBe('-Users-max-Documents-------agentic-harness');
  });
});
