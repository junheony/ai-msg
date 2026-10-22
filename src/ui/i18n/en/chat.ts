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
  },
  account: (name: string) => `Account ${name}`,
  images: (n: number) => (n === 1 ? '1 image' : `${n} images`),
};
