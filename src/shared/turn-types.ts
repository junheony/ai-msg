export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

export const ZERO_USAGE: TurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

/** UI buttons: 허용 1회 / 이 세션 동안 / 거부. */
export type PermissionDecision = 'once' | 'session' | 'deny';
