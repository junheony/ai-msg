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
  /** Full-size image viewer (사진 크게 보기); `count` = position in a gallery. */
  lightbox: { close: 'Close', prev: 'Previous image', next: 'Next image', count: (i: number, n: number) => `${i} / ${n}` },
  /** A sent / transcript image's thumbnail button (`name` = file name, or `image(i)` for a transcript image). */
  viewImage: (name: string) => `View ${name} larger`,
  image: (i: number) => `Image ${i}`,
  /** The pill over a transcript scrolled up: back to the end, or how many messages came in meanwhile. */
  jump: { bottom: 'Jump to bottom', unread: (n: number) => (n === 1 ? '1 new message' : `${n} new messages`) },
  /** 'olderHistory': the line at the top of the transcript — load earlier messages, loading, or the start reached. */
  older: { more: 'Show earlier messages', loading: 'Loading earlier messages…', start: 'Start of the conversation', retry: 'Couldn’t load earlier messages · Try again' },
  /** 한도가 풀리면 자동으로 이어가기: the session's one line (`time` = local H:MM) and its cancel button. */
  composer: {
    stop: 'Stop',
    stopEsc: 'Stop (Esc)',
    queueAdd: 'Add to queue',
    queueSteerTitle: 'Add to queue (Enter) — sent to the running turn, delivered after the next tool run',
    queueWaitTitle: 'Add to queue (Enter) — sent when the current turn ends',
  },
  autoResume: { at: (time: string) => `Continues automatically at ${time}`, cancel: 'Cancel' },
  /** A question / approval card waits for the user: the status line and the composer say so. */
  waiting: {
    question: 'Waiting for your answer',
    permission: 'Waiting for your approval',
    placeholderQuestion: 'Answer the question above, or type a message',
    placeholderPermission: 'Approve the request above, or type a message',
  },
  placeholder: 'Send a message',
  /** A long fenced code block shows its first lines; the toggle under it. */
  code: { more: (n: number) => `Show ${n} more line${n === 1 ? '' : 's'}`, less: 'Show less' },
  taskMenu: 'Run as a separate task',
  /** The phone's text-selection screen (message long press → Select text): the message as plain text to select from. */
  selectText: { title: 'Select text', copyAll: 'Copy all', copied: 'Copied' },
  /** The new-chat screen; `intro`…`homeFailed` = the first run (no folders yet). */
  newChat: {
    send: 'Send — start a new chat (Enter)',
    firstLabel: 'Get started',
    intro: 'Pick a folder and work in it together with AI.',
    pick: 'Pick a folder',
    orHome: 'Or just type below to start in your home folder.',
    home: 'Home folder',
    homeFailed: "Couldn't open your home folder. Try picking a folder.",
  },
  /** A Grok Bot app conversation: sending continues it in a Grok session (the app conversation itself is never written). */
  grokBot: {
    placeholderNew: 'Send to continue in a new Grok session',
    placeholderLinked: 'Send to continue in the Grok session you already started',
    linkedNote: (title: string) => `Goes to the continuing session “${title}”`,
    cwdNote: (cwd: string) => `Working folder: ${cwd}`,
    pickFirst: "Sending asks for a working folder first — never starts in your home folder",
    pickThenSend: 'Pick a working folder and your message goes out right away',
    cwdChangeable: (cwd: string) => `Working folder: ${cwd} — you can change it before sending`,
    pickCwd: 'Pick a working folder — never starts in your home folder',
    pickToSend: 'Pick a working folder to send',
    continueNew: 'Continue in a new Grok session',
    openLinked: 'Open the continuing session',
    tag: 'From Grok Bot',
    rowTitle: (preview: string) => `Grok Bot app conversation — sending here continues it in a new Grok session (the app conversation itself is not written)${preview}`,
  },
};
