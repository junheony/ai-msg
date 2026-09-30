export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

export const ZERO_USAGE: TurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

/** UI buttons: 허용 1회 / 이 세션 동안 / 거부. */
export type PermissionDecision = 'once' | 'session' | 'deny';

/** One AskUserQuestion entry as the SDK's AskUserQuestionInput.questions[] spells it (previews dropped). */
export type Question = { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean };

/** question text → chosen label(s); multi-select answers are comma-separated (sdk-tools.d.ts AskUserQuestionOutput.answers). */
export type QuestionAnswers = Record<string, string>;
