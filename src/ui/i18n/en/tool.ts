// A tool call's row and its opened detail (ToolCallView), and the diff card's wrap switch (DiffView).

export const tool = {
  error: 'Failed',
  running: 'Running…',
  exitCode: (n: number) => `Exit code ${n}`,
  command: 'Command',
  input: 'Input',
  output: 'Output',
  copyCommand: 'Copy command',
  copyInput: 'Copy input',
  copyOutput: 'Copy output',
  raw: 'Raw input',
  noOutput: 'No output',
  showAll: (lines: number) => `Show all (${lines} lines)`,
  showTail: (lines: number) => `Last ${lines} lines only`,
  hiddenLines: (n: number) => (n === 1 ? '1 earlier line hidden' : `${n} earlier lines hidden`),
  hiddenChars: (n: string) => `First ${n} characters hidden`,
  serverCut: (shown: string, total: string) => `Output too long: only the first ${shown} of ${total} characters were kept`,
  wrap: 'Wrap',
  wrapTitle: 'Wrap long lines (all code blocks and diffs)',
};
