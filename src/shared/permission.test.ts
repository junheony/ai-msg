import { describe, expect, it } from 'vitest';
import { PERM_MODES, isPermMode, nextPermMode, permModeFromAutoApprove, permModeHint, permModesFor, sdkPermMode } from './permission';

describe('permission modes', () => {
  it('Shift+Tab cycles 매번 묻기 → 편집 자동 승인 → 계획 모드 → 모두 자동 승인 → 매번 묻기', () => {
    expect(PERM_MODES.map((m) => nextPermMode(m))).toEqual(['acceptEdits', 'plan', 'bypassPermissions', 'default']);
  });

  it('Grok: no plan mode (§14.2); Shift+Tab skips it and a stored plan moves on to 매번 묻기; hints name the no-approval list', () => {
    expect(permModesFor('grok')).toEqual(['default', 'acceptEdits', 'bypassPermissions']);
    expect(permModesFor('claude')).toEqual(PERM_MODES);
    expect(nextPermMode('acceptEdits', 'grok')).toBe('bypassPermissions');
    expect(nextPermMode('bypassPermissions', 'grok')).toBe('default');
    expect(nextPermMode('plan', 'grok')).toBe('default');
    for (const m of permModesFor('grok')) expect(permModeHint(m, 'grok')).toContain('Grok 은 읽기 명령·mkdir·touch 를 승인 없이 실행');
    expect(permModeHint('default', 'claude')).not.toContain('Grok');
  });

  it('maps to the SDK mode; 모두 자동 승인 is never handed over as bypassPermissions', () => {
    expect(sdkPermMode('default')).toBe('default');
    expect(sdkPermMode('acceptEdits')).toBe('acceptEdits');
    expect(sdkPermMode('plan')).toBe('plan');
    expect(sdkPermMode('bypassPermissions')).toBe('default');
  });

  it('migrates the old 자동 승인 switch and validates', () => {
    expect(permModeFromAutoApprove(true)).toBe('bypassPermissions');
    expect(permModeFromAutoApprove(false)).toBe('default');
    expect(isPermMode('plan')).toBe(true);
    expect(isPermMode('dontAsk')).toBe(false);
    expect(isPermMode(1)).toBe(false);
  });
});
