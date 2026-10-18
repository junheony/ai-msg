/**
 * Per-session permission modes (Claude Code / Desktop's Shift+Tab modes). `bypassPermissions` is deck's name for
 * 모두 자동 승인: it is never handed to the SDK as such — canUseTool allows each call (audited), so settings deny rules,
 * hooks and the handoff turn's tool block still apply.
 */
export const PERM_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const;
export type PermMode = (typeof PERM_MODES)[number];

export const PERM_MODE_LABEL: Record<PermMode, string> = {
  default: '매번 묻기',
  acceptEdits: '편집 자동 승인',
  plan: '계획 모드',
  bypassPermissions: '모두 자동 승인',
};

export const PERM_MODE_HINT: Record<PermMode, string> = {
  default: '도구 호출마다 권한 카드로 묻습니다',
  acceptEdits: '파일 편집은 묻지 않고 허용, 그 밖의 도구는 묻습니다',
  plan: '읽기만 하며 계획을 세웁니다. 계획이 나오면 승인 카드로 진행 여부를 묻습니다',
  bypassPermissions: '모든 도구 호출을 묻지 않고 허용합니다(감사 로그에 기록). 설정의 거부 규칙은 그대로 적용됩니다',
};

/** Said on every Grok mode (Grok's own no-approval list, S13; deck cannot gate those). */
export const GROK_NO_APPROVAL_NOTE = 'Grok 은 읽기 명령·mkdir·touch 를 승인 없이 실행';
/** 모두 자동 승인 on a Grok session (GrokEngine isGrokAutoApprovable): only the listed kinds, once each. */
export const GROK_BYPASS_HINT = `허용된 종류(편집·실행·읽기·가져오기·검색)만 한 번씩 자동 승인, 권한 넓히기는 카드로 묻기. ${GROK_NO_APPROVAL_NOTE}`;
/** Grok's hints (§14.1-3: deck answers Grok's permission requests; Grok's own mode stays default). */
export const GROK_PERM_MODE_HINT: Record<Exclude<PermMode, 'plan'>, string> = {
  default: `쓰기·실행마다 권한 카드로 묻습니다. ${GROK_NO_APPROVAL_NOTE}`,
  acceptEdits: `작업 폴더 안 파일 편집은 묻지 않고 허용(.git·.env 등 민감한 곳은 카드), 실행은 묻습니다. ${GROK_NO_APPROVAL_NOTE}`,
  bypassPermissions: GROK_BYPASS_HINT,
};

/** The hint for a mode on a session of `engine` (Grok's modes are answered by deck; its 모두 자동 승인 is narrower). */
export function permModeHint(m: PermMode, engine: string): string {
  return engine === 'grok' && m !== 'plan' ? GROK_PERM_MODE_HINT[m] : PERM_MODE_HINT[m];
}

/** Modes offered for a session of `engine`: Grok has no plan mode in deck yet (§14.2). */
export function permModesFor(engine?: string): readonly PermMode[] {
  return engine === 'grok' ? PERM_MODES.filter((m) => m !== 'plan') : PERM_MODES;
}

export function isPermMode(x: unknown): x is PermMode {
  return typeof x === 'string' && (PERM_MODES as readonly string[]).includes(x);
}

/** Shift+Tab: the next mode in PERM_MODES order (the engine's offered ones), wrapping around. */
export function nextPermMode(m: PermMode, engine?: string): PermMode {
  const modes = permModesFor(engine);
  return modes[(modes.indexOf(m) + 1) % modes.length]!;
}

/** The SDK `Options.permissionMode` for a deck mode (bypass runs as 'default' + canUseTool auto-allow). */
export function sdkPermMode(m: PermMode): 'default' | 'acceptEdits' | 'plan' {
  return m === 'bypassPermissions' ? 'default' : m;
}

/** The old global 자동 승인 switch → the default mode for new sessions. */
export function permModeFromAutoApprove(autoApprove: boolean): PermMode {
  return autoApprove ? 'bypassPermissions' : 'default';
}
