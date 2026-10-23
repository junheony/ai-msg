/** Shortcut help, command palette and activity sheet (R2-C). */
export const panels = {
  /** ⌘/ cheat sheet: the groups its rows are sorted into. */
  help: { title: 'Keyboard shortcuts', close: 'Close', move: 'Navigate', compose: 'Write', panes: 'Panes & cards' },
  palette: {
    searching: 'Searching…',
    empty: 'Nothing matches',
    /** No results: what can be done instead. */
    clear: 'Clear search',
    newChat: 'Start a new chat',
  },
  activity: {
    /** How long the server process has been running (under the 서버 heading). */
    upJust: 'Server just started',
    upMin: (n: number) => `Server running for ${n} min`,
    upHour: (n: number) => `Server running for ${n} h`,
    upDay: (n: number) => (n === 1 ? 'Server running for 1 day' : `Server running for ${n} days`),
    startedAt: (when: string) => `Started ${when}`,
    idle: 'Nothing is running right now',
    idleSince: (time: string) => `Nothing is running right now · last work finished at ${time}`,
    newChat: 'Start a new chat',
  },
};
