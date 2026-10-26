import { describe, expect, it } from 'vitest';
import { tabTitle } from './tabTitle';

describe('tabTitle', () => {
  it('shows the chat title before the app name, after the status mark', () => {
    expect(tabTitle(null, '버그 고치기')).toBe('버그 고치기 — Crew');
    expect(tabTitle('●', '버그 고치기')).toBe('● 버그 고치기 — Crew');
    expect(tabTitle('✓', '버그 고치기')).toBe('✓ 버그 고치기 — Crew');
  });
  it('just Crew without a chat', () => {
    expect(tabTitle(null, null)).toBe('Crew');
    expect(tabTitle('●', '  ')).toBe('● Crew');
  });
});
