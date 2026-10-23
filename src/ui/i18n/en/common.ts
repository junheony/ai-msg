// Words many screens share.

export const common = {
  copy: 'Copy',
  settings: 'Settings',
  periodFiveHour: '5h',
  periodWeek: 'Wk',
  periodMonth: 'Mo',
  /** The connection bar (App): a short drop, the server restarting (it announced a drain), and a long drop since `since` (HH:MM). */
  connReconnecting: 'Reconnecting…',
  connRestarting: 'The server is restarting… picks up by itself once connected',
  connDown: (since: string) => `Can't reach the server · since ${since} — picks up by itself once connected`,
  retry: 'Retry',
  /** The skip link (App): the first thing Tab reaches. */
  skipToMain: 'Skip to main content',
  /** A queued message that did not go out while offline (QueueChips). */
  unsent: 'Not sent',
  unsentHint: 'The connection dropped before this went out — it is sent once connected (or tap Resend)',
  /** …and one that may already have gone in (its answer was lost) that the history can tell: checked once connected, never offered to resend. */
  checking: 'Checking',
  checkingHint: 'It may already have gone in — checked against the conversation once connected, and sent only if it did not',
  /** …one that no history can tell (a new session): the user decides, connected or not. */
  maybeGone: 'May have been sent',
  maybeGoneHint: 'It may already have gone in — once connected, check the conversation and send it yourself',
  /** The offline button when the queue holds such a message: it only connects, the queue stays paused. */
  reconnect: 'Reconnect',
  resend: 'Resend',
  /** Error codes put into words (errorText.ts); the raw text folds underneath. */
  errorRaw: 'Original message',
  errors: {
    execution: 'The AI stopped with an error while working. Send again to retry.',
    maxTurns: 'The AI hit its step limit for this turn. Send "continue" to go on.',
    maxBudget: 'This turn hit its spending limit.',
    overloaded: 'The AI service is busy right now. Try again in a moment.',
    rateLimit: 'Too many requests right now. Try again in a moment.',
    auth: 'The AI account is not logged in or its login expired. Check the account in Settings.',
    network: 'The connection to the AI service dropped. Try again in a moment.',
    timeout: 'The AI took too long to answer. Try again.',
    unknown: 'Something went wrong. Try again.',
  },
};
