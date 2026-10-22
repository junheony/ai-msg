// Server-side strings for turns: 다른 AI 로 이어가기 (crossEngineFailover).

export const turn = {
  /** The pane's notice when a limit moves the conversation to another engine. */
  crossNotice: (from: string, to: string) => `${from} hit its limit — continuing with ${to}`,
  /** The new session's hidden context: what it takes over and an excerpt of the earlier conversation. */
  crossCarry: (from: string, excerpt: string) =>
    `[deck] This new session takes over a conversation the user was having with another AI (${from}): deck moved it here by itself because ${from} hit its usage limit. Below is an excerpt of the earlier conversation (tool calls left out, secrets masked). Answer this message, and tell the user in one line that you took over.\n\n${excerpt || '(no earlier conversation to excerpt)'}`,
  /** A background continuation moved to another engine: the message it sends there. */
  crossContinue: 'Please continue.',
  crossCarried: 'Only a summary excerpt of the earlier conversation is carried over',
  crossNotCarried: 'The earlier conversation could not be carried over',
};
