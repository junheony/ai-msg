// The conversation view: a reply's one-line meta (model · thinking · tools · roles · background) and the user bubble.

export const chat = {
  meta: {
    label: 'Turn details',
    thinking: 'Thinking…',
    thought: 'Thought',
    thoughtFor: (s: number) => `Thought for ${s}s`,
    process: 'Thinking process',
    live: 'Still working',
    step: (n: number) => `step ${n}`,
    running: 'running…',
    errors: (n: number) => `${n} failed`,
  },
  bg: {
    completed: 'Background done',
    failed: 'Background failed',
    stopped: 'Background stopped',
    running: 'Background running',
    other: 'Background update',
    raw: 'Show original',
  },
  roles: {
    agents: (n: number) => `${n} subagent${n === 1 ? '' : 's'}`,
    offloads: (n: number) => `offload ${n}`,
    defaultModel: 'default model',
    auto: 'auto',
  },
  agent: {
    result: 'Result',
    prompt: 'Prompt',
    fallback: 'Agent',
    background: 'Background',
    tokens: (n: string) => `${n} tokens`,
    more: (n: number) => `+${n} more`,
  },
  account: (name: string) => `Account ${name}`,
  accountNote: { unknown: 'not in settings', retired: 'removed account', pinned: 'pinned', pin: 'Pinned account' },
  images: (n: number) => (n === 1 ? '1 image' : `${n} images`),
  /** 한도가 풀리면 자동으로 이어가기: the session's one line (`time` = local H:MM) and its cancel button. */
  composer: {
    stop: 'Stop',
    stopEsc: 'Stop (Esc)',
    queueAdd: 'Add to queue',
    queueSteerTitle: 'Add to queue (Enter) — sent to the running turn, delivered after the next tool run',
    queueWaitTitle: 'Add to queue (Enter) — sent when the current turn ends',
  },
  autoResume: { at: (time: string) => `Continues automatically at ${time}`, cancel: 'Cancel' },
};
