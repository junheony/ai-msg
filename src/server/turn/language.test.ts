import { describe, expect, it } from 'vitest';
import { languageDirective, turnLanguage } from './language';

describe('reply-language note', () => {
  it('Korean: replies and question cards in Korean, code as-is; English and none: no note', () => {
    const ko = languageDirective('ko', { questionTool: true })!;
    expect(ko).toContain('Respond to the user in Korean (한국어).');
    expect(ko).toContain('Write AskUserQuestion questions, headers, options and descriptions in Korean too.');
    expect(ko).toContain('Keep code, commands and identifiers as-is.');
    expect(languageDirective('ko')).not.toContain('AskUserQuestion');
    expect(languageDirective('ko')).toContain('choice options in Korean');
    expect(languageDirective('en', { questionTool: true })).toBeNull();
    expect(languageDirective(undefined)).toBeNull();
    expect(languageDirective(null)).toBeNull();
  });

  it("an explicit settings language wins over the device's; neither = none", () => {
    expect(turnLanguage('en', 'ko')).toBe('en');
    expect(turnLanguage('ko', 'en')).toBe('ko');
    expect(turnLanguage(null, 'ko')).toBe('ko');
    expect(turnLanguage(undefined, 'en')).toBe('en');
    expect(turnLanguage(undefined, undefined)).toBeUndefined();
  });
});
