import { relPath } from './diff';

// What a tool call's opened row shows in place of its raw JSON (ToolCallView): a shell command as one `$ …` line, a file
// path relative to the session folder, other inputs as short key: value lines; and its output's tail, cut notes and exit code.

type Rec = Record<string, unknown>;
export type Field = { key: string; value: string };
export type InputView =
  /** A shell call (Claude Bash, Codex shell / exec_command, Grok run_terminal_command, Gemini run_shell_command: ALIAS). */
  | { kind: 'command'; command: string; fields: Field[] }
  /** Anything else with an object input: its file (relative to cwd, if any) and the remaining keys. */
  | { kind: 'fields'; path: string | null; fields: Field[] }
  /** A plain string input (Codex apply_patch's raw patch) or a non-object. */
  | { kind: 'raw'; text: string };

/** Other engines' tool names → the Claude tool they match, for the row's label (Codex history, Gemini, Grok `grok:<name>`). */
const ALIAS: Record<string, string> = {
  shell: 'Bash', local_shell: 'Bash', exec_command: 'Bash', 'container.exec': 'Bash', run_shell_command: 'Bash',
  'grok:run_terminal_command': 'Bash', 'grok:bash': 'Bash', 'grok:shell': 'Bash', 'grok:terminal': 'Bash', 'grok:execute': 'Bash',
  read_file: 'Read', 'grok:read_file': 'Read', 'grok:read': 'Read', 'grok:view_file': 'Read',
  write_file: 'Write', 'grok:write': 'Write', 'grok:create_file': 'Write',
  replace: 'Edit', 'grok:search_replace': 'Edit', 'grok:str_replace': 'Edit', 'grok:edit': 'Edit', 'grok:multi_edit': 'MultiEdit',
  search_file_content: 'Grep', 'grok:grep': 'Grep', glob: 'Glob', 'grok:glob': 'Glob',
  web_fetch: 'WebFetch', google_web_search: 'WebSearch', 'grok:web_search': 'WebSearch', 'grok:spawn_subagent': 'Task',
};
export const canonicalTool = (name: string): string => ALIAS[name] ?? name;
/** Keys naming the file a call works on (Claude file_path / notebook_path, Grok path, Gemini absolute_path, others target_file). */
const PATH_KEYS = ['file_path', 'notebook_path', 'absolute_path', 'target_file', 'path'];
/** Shown elsewhere (the row's label, the diff card) or engine-internal: left out of the key: value lines. */
const HIDDEN = new Set(['description', 'variant', 'old_string', 'new_string', 'content', 'edits', 'new_source']);
const VALUE_MAX = 400;

const rel = (p: string, cwd?: string | null) => (cwd && p.replace(/\/$/, '') === cwd.replace(/\/$/, '') ? '.' : relPath(p, cwd));
const clip = (s: string, n = VALUE_MAX) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** `["bash", "-lc", "ls"]` → `ls`; other argv arrays joined with spaces. */
export function commandOf(i: Rec): string | null {
  const c = i.command ?? i.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) {
    const a = c as string[];
    if (a.length === 3 && /(^|\/)(ba|z)?sh$/.test(a[0]!) && (a[1] === '-lc' || a[1] === '-c')) return a[2]!;
    return a.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ');
  }
  return null;
}

function fieldsOf(i: Rec, skip: Set<string>, cwd?: string | null): Field[] {
  const out: Field[] = [];
  for (const [key, v] of Object.entries(i)) {
    if (skip.has(key) || HIDDEN.has(key) || v === undefined || v === null || v === false || v === '') continue;
    const value = typeof v === 'string' ? rel(v, cwd) : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
    out.push({ key, value: clip(value) });
  }
  return out;
}

export function inputView(name: string, input: unknown, cwd?: string | null): InputView {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { kind: 'raw', text: typeof input === 'string' ? input : JSON.stringify(input ?? null, null, 2) };
  const i = input as Rec;
  const command = canonicalTool(name) === 'Bash' ? commandOf(i) : null;
  if (command !== null) return { kind: 'command', command, fields: fieldsOf(i, new Set(['command', 'cmd']), cwd) };
  const key = PATH_KEYS.find((k) => typeof i[k] === 'string' && i[k]);
  return { kind: 'fields', path: key ? rel(i[key] as string, cwd) : null, fields: fieldsOf(i, new Set(key ? [key] : []), cwd) };
}

/** The server's cut marker (sessions/transcript.ts, engine/codexRollout.ts): the head was kept, `total` chars originally. */
const SERVER_CUT = /\n…\[잘림: 원래 (\d+)자\]$/;
/** Claude's Bash on a non-zero exit starts its result with this line. */
const CLAUDE_EXIT = /^Exit code (-?\d+)(?:\n|$)/;
/** Grok's terminal output ends with it. */
const GROK_EXIT = /(?:^|\n)exit: (-?\d+)\s*$/;

export type OutputView = { text: string; exitCode: number | null; serverCut: { shown: number; total: number } | null };

export function outputView(result: string): OutputView {
  let text = result;
  let serverCut: OutputView['serverCut'] = null;
  const cut = SERVER_CUT.exec(text);
  if (cut) { text = text.slice(0, cut.index); serverCut = { shown: text.length, total: Number(cut[1]) }; }
  let exitCode: number | null = null;
  const c = CLAUDE_EXIT.exec(text);
  if (c) { exitCode = Number(c[1]); text = text.slice(c[0].length); }
  else {
    const g = GROK_EXIT.exec(text);
    if (g) { exitCode = Number(g[1]); text = text.slice(0, g.index); }
  }
  return { text: text.replace(/\n+$/, ''), exitCode, serverCut };
}

/** Lines shown before "전체 보기", and the most characters those lines may take (one huge line stays bounded). */
export const TAIL_LINES = 12;
export const TAIL_CHARS = 3000;
/** "전체 보기" still keeps at most this much (the end): a live result can be megabytes. */
export const FULL_CHARS = 200_000;

/**
 * The end of `text`: the last `lines` lines, at most `chars` characters. `hiddenLines` / `hiddenChars` say what was left
 * out in front (hiddenChars only when the cut fell inside a line). A text a little over `lines` is shown whole.
 */
export function tailOf(text: string, lines: number, chars: number): { text: string; hiddenLines: number; hiddenChars: number } {
  const all = text.split('\n');
  let shown = text;
  let hiddenLines = 0;
  if (all.length > lines + 3) { hiddenLines = all.length - lines; shown = all.slice(-lines).join('\n'); }
  if (shown.length > chars) return { text: shown.slice(-chars), hiddenLines: 0, hiddenChars: text.length - chars };
  return { text: shown, hiddenLines, hiddenChars: 0 };
}
