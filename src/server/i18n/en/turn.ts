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
  /** Continuing the sessions a restart cut (push/restartResume): what deck sends to each session the last restart cut; `tasks`: the cut background work, comma-separated ('' for none). */
  restartResume: {
    /** The message starts with this (TurnRunner tells its turn apart by it for the notice). */
    lead: 'The server restarted and cut off the work this session was doing.',
    prompt: (tasks: string) =>
      `The server restarted and cut off the work this session was doing.${tasks ? ` Background work that was cut: ${tasks}.` : ''} Check how far it got; if needed, set the cut work up again (including any waits, sleeps or monitors) and continue. (AI-MSG sent this automatically.)`,
    /** The pane's notice on that turn. */
    notice: 'Continuing automatically after a server restart cut the work',
    /** deck.log: how many sessions were booked. */
    log: (n: number) => `deck: booked ${n} session(s) cut by the restart to continue automatically`,
    /** deck.log: sessions sent on after the last restart and cut again, skipped this once (ids, space-separated). */
    repeatSkipped: (ids: string) => `deck: not continuing again after the restart (already continued after the last one): ${ids}`,
  },
};
