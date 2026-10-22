// The settings sheet (the rest moves here in Task 2).

export const settings = {
  language: 'Language',
  languageAuto: 'Auto',
  languageHint: 'Notifications and server messages use the language you last picked on any device.',
  /** 자동 분배 › 다른 AI 로 이어가기 (crossEngineFailover): the switch and what it does (owner's decision 2026-10-22). */
  crossEngineFailover: 'Continue with another AI at a limit',
  crossEngineFailoverHint: 'When a limit is hit, deck continues with another AI by itself. Gemini and Grok only if you agreed to sending to them.',
  /** 실험적 기능 › 다른 앱 연동: the sub-group's title and what it says before its switches (the owner's wording). */
  experimentalAppsTitle: 'Other apps',
  experimentalBadge: 'Experimental · unofficial',
  experimentalNotice: "Not official features: any app's update can stop them at any time. Turned on, they read that app's local files.",
  /**
   * 실험적 기능 › 계정 순환: the sub-group's title and what it says before its switch (it reads no other app's files). Owner's
   * decision 2026-10-22: 벤더 간 자동 분배 is on for everyone; same-vendor rotation is the user's own pick, then automatic.
   */
  rotationTitle: 'Account rotation',
  rotationNotice: "Turned on, a limit moves to your next account by itself. Under each provider's terms, use it only across accounts you pay for yourself, for personal use.",
};
