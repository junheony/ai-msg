/**
 * §14.9-3 tripwire: Grok's session mode is always `default`, so a tool that changes things reaches `in_progress` or a
 * terminal status only after a permission request for its toolCallId. One that does so with no request is a leak in
 * the gate — unless it is on Grok's documented no-approval list (S13): the read tools, read-only shell, `mkdir`,
 * `touch`. This module decides "on the list"; GrokEngine decides "no request was seen".
 *
 * The shell check is deliberately narrow: a command counts as read-only only when every piece of it is a known
 * read command with no redirect, substitution, run/write flag, or word the shell would rewrite (a quote inside a word,
 * `\`, `$`). A false alarm stops the turn; a miss would hide a leak.
 */

/** Kinds that change things (ACP ToolKind). */
export const TRIPWIRE_KINDS: ReadonlySet<string> = new Set(['edit', 'delete', 'move', 'execute']);

/** Grok tool names (`_meta["x.ai/tool"].name`) that run without approval in every mode (S13). */
export const GROK_READ_TOOLS: ReadonlySet<string> = new Set(['read_file', 'list_dir', 'grep', 'glob', 'web_search', 'web_fetch', 'todo_write', 'skill', 'use_skill']);

const READ_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'fd', 'tree',
  'stat', 'file', 'du', 'df', 'which', 'type', 'whereis', 'sort', 'uniq', 'cut', 'tr', 'nl', 'diff', 'cmp', 'basename',
  'dirname', 'realpath', 'readlink', 'date', 'whoami', 'id', 'uname', 'true', 'false', 'test', '[', 'jq', 'cd',
  'mkdir', 'touch',
]);
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'grep', 'ls-tree', 'cat-file', 'merge-base', 'rev-list']);
const FIND_WRITE = new Set(['-exec', '-execdir', '-delete', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls']);

/** Harmless redirects removed before the check: discarding output or merging stderr. */
const SAFE_REDIRECT = /\s(?:[12]?>\s*\/dev\/null|2>&1|1>&2|>&2)(?=\s|$)/g;

/** Placeholder for the n-th quoted string (its text is kept aside so flag checks still see it). */
const MARK = /^\u0001(\d+)\u0001$/;

/**
 * The words of one segment. A word is either one whole quoted string (its text, from `quoted`) or plain text; a word
 * that mixes the two, or holds a backslash or `$`, is something the shell would rewrite (`-"exec"`, `-ex\ec`, `$X`):
 * null, so the command is not read-only.
 */
function words(segment: string, quoted: string[]): string[] | null {
  const out: string[] = [];
  for (const w of segment.split(/\s+/).filter(Boolean)) {
    const m = MARK.exec(w);
    if (m) { out.push(quoted[Number(m[1])]!); continue; }
    if (/[\u0001"'\\$`]/.test(w)) return null;
    out.push(w);
  }
  return out;
}

function readOnlyGit(args: string[]): boolean {
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === '--no-pager' || a === '--no-optional-locks') { i++; continue; }
    if (a === '-C') { i += 2; continue; }
    break;
  }
  const sub = args[i];
  if (!sub) return false;
  const rest = args.slice(i + 1);
  if (rest.some((a) => a === '--output' || a.startsWith('--output=') || a === '--ext-diff')) return false;
  // git grep -O / --open-files-in-pager runs a pager program on the matches.
  if (sub === 'grep' && rest.some((a) => a.startsWith('-O') || a.startsWith('--open-files-in-pager'))) return false;
  if (GIT_READ.has(sub)) return true;
  if (sub === 'branch') return rest.every((a) => ['-a', '-r', '-v', '-vv', '--list', '--all', '--remotes', '--show-current', '--no-color', '--color'].includes(a));
  if (sub === 'remote') return rest.every((a) => a === '-v' || a === '--verbose');
  if (sub === 'stash') return rest[0] === 'list' || rest[0] === 'show';
  if (sub === 'tag') return rest.length === 0 || rest.every((a) => a === '-l' || a === '--list');
  return false;
}

/** True when every piece of `command` is a read-only shell command (or mkdir / touch). */
export function isReadOnlyShell(command: string): boolean {
  if (!command.trim() || command.includes('\u0001')) return false;
  // Quoted text is data: set aside before the operator check, except that "$(…)" / backticks / $VAR / \ inside "…" are not.
  const quoted: string[] = [];
  let quotedRun = false;
  const unquoted = command.replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g, (_m, single: string | undefined, double: string | undefined) => {
    if (double !== undefined && /[$`\\]/.test(double)) quotedRun = true;
    quoted.push(single ?? double ?? '');
    return `\u0001${quoted.length - 1}\u0001`;
  });
  if (quotedRun || /["']/.test(unquoted)) return false;
  const cleaned = ` ${unquoted} `.replace(SAFE_REDIRECT, ' ');
  // Any other redirect, substitution, here-doc or background job: not read-only.
  if (/[<>`&]|\$\(/.test(cleaned.replace(/&&/g, ''))) return false;
  for (const segment of cleaned.split(/&&|\|\||[;|\n]/)) {
    const w = words(segment.trim(), quoted);
    if (!w || w.length === 0) return false;
    const cmd = w[0]!.split('/').at(-1)!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) return false;
    if (cmd === 'git') { if (!readOnlyGit(w.slice(1))) return false; continue; }
    if (!READ_COMMANDS.has(cmd)) return false;
    const args = w.slice(1);
    if (!readOnlyArgs(cmd, args)) return false;
  }
  return true;
}

/** Short-flag cluster (`-Hx`) holding one of `letters`. */
const shortHas = (a: string, letters: string) => /^-[A-Za-z0-9]+$/.test(a) && [...letters].some((l) => a.slice(1).includes(l));

/** Per-command flags that run another program or write a file. */
function readOnlyArgs(cmd: string, args: string[]): boolean {
  switch (cmd) {
    case 'find': return !args.some((a) => FIND_WRITE.has(a));
    case 'fd': return !args.some((a) => a.startsWith('--exec') || shortHas(a, 'xX'));
    case 'rg': return !args.some((a) => a === '--pre' || a.startsWith('--pre='));
    case 'ag': return !args.some((a) => a.startsWith('--pager'));
    case 'tree': return !args.some((a) => a.startsWith('-o') || a.startsWith('--output'));
    case 'sort': return !args.some((a) => a.startsWith('--output') || a.startsWith('--compress-program') || (/^-[^-]/.test(a) && a.includes('o')));
    case 'file': return !args.some((a) => a === '--compile' || shortHas(a, 'C'));
    case 'uniq': {
      // `uniq IN OUT` writes OUT: more than one file operand.
      let files = 0;
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a === '-f' || a === '-s' || a === '-w') { i++; continue; }
        if (!a.startsWith('-') || a === '-') files++;
      }
      return files <= 1;
    }
    default: return true;
  }
}

/**
 * True when a tool that ran with no permission request for its id is a leak: a changing kind, not a Grok read tool,
 * and (for a shell call) not a read-only command. `rawInput.command` is the shell line (Grok's Bash variant).
 */
export function isTripwire(kind: string, toolName: string | null, rawInput: unknown): boolean {
  if (!TRIPWIRE_KINDS.has(kind)) return false;
  if (toolName && GROK_READ_TOOLS.has(toolName)) return false;
  if (kind === 'execute') {
    const r = rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : {};
    const cmd = typeof r.command === 'string' ? r.command : typeof r.cmd === 'string' ? r.cmd : null;
    return cmd === null || !isReadOnlyShell(cmd);
  }
  return true;
}
