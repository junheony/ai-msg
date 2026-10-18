import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import type { SessionHolder } from '../../shared/session-types';

// `--resume=<id>`, `--resume <id>` and the short `-r <id>`.
const RESUME = /\s(?:--resume[= ]|-r\s+)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f-])/gi;

/**
 * Whether the row is a `claude` CLI: the executable's basename is `claude`, also behind an interpreter (`node …/bin/claude`)
 * or Claude Desktop's `disclaimer --pgroup -- <path>/claude` wrapper, or it is the npm package's `cli.js`. `ps` joins argv with spaces and the paths have
 * spaces of their own (`Application Support`), so "the executable" is what precedes the first ` -flag`. A
 * `grep -- '--resume=<id>'` or a `zsh -c 'claude --resume …'` wrapper is not one.
 */
function isClaudeCli(command: string): boolean {
  const exe = (c: string) => c.split(/\s-/, 1)[0]!.trimEnd();
  let head = exe(command);
  if (head.endsWith('/disclaimer') || head === 'disclaimer') {
    const rest = command.indexOf(' -- ');
    if (rest < 0) return false;
    head = exe(command.slice(rest + 4));
  }
  // `node /path/claude`: the script is the executable. Any other leading word (`vim /notes/claude`) is another program's argument.
  const script = /^(?:\S*\/)?(?:node|bun)\s+(.*)$/.exec(head);
  if (script) head = script[1]!;
  else if (!head.startsWith('/') && /\s/.test(head)) return false;
  return head.slice(head.lastIndexOf('/') + 1) === 'claude' || head.endsWith('/claude-code/cli.js');
}

/**
 * Whether the row is a `grok` CLI: the executable's basename is `grok`, also behind `node`/`bun` (same reading of the
 * `ps` line as isClaudeCli). `vim /notes/grok` or `zsh -c 'grok …'` is not one.
 */
export function isGrokCli(command: string): boolean {
  let head = command.split(/\s-/, 1)[0]!.trimEnd();
  const script = /^(?:\S*\/)?(?:node|bun)\s+(.*)$/.exec(head);
  if (script) head = script[1]!;
  // A bare `grok <session-id>` / `grok resume …`: only the first word is the executable.
  else if (!head.startsWith('/')) head = head.split(/\s/, 1)[0]!;
  else if (/\s/.test(head)) {
    // An absolute path with spaces (`/Applications/X Y/grok args…`): take the longest prefix ending in `/grok`.
    const m = /^(.*\/grok)(?:\s|$)/.exec(head);
    if (m) head = m[1]!;
  }
  return head.slice(head.lastIndexOf('/') + 1) === 'grok';
}

/** deck's own Grok children always run `grok agent --no-leader stdio` (GrokEngine's GROK_AGENT_ARGS). */
export const GROK_DECK_CHILD_ARGS = 'agent --no-leader stdio';

/** Grok CLIs outside deck, from the same `ps` output: every argv token (a session id is matched by equality), and their pids (for the cwd lookup). */
export type GrokHolders = { tokens: Set<string>; pids: number[] };

export function parseGrokHolders(psText: string, self: HolderSelf): GrokHolders {
  const rows: { pid: number; ppid: number; command: string }[] = [];
  for (const line of psText.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]!.normalize('NFC') });
  }
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  const underDeck = (pid: number) => {
    for (let p: number | undefined = pid, i = 0; p !== undefined && p > 1 && i < 64; p = parent.get(p), i++) if (p === self.pid) return true;
    return false;
  };
  const out: GrokHolders = { tokens: new Set(), pids: [] };
  for (const r of rows) {
    if (!isGrokCli(r.command) || underDeck(r.pid) || r.command.includes(GROK_DECK_CHILD_ARGS)) continue;
    out.pids.push(r.pid);
    for (const t of r.command.split(/\s+/)) {
      const v = t.includes('=') ? t.slice(t.indexOf('=') + 1) : t;
      if (v) out.tokens.add(v);
    }
  }
  return out;
}

/** `lsof -Fn` output → the cwd of each listed process. */
export function parseLsofCwds(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split('\n')) if (line.startsWith('n/')) out.add(line.slice(1).normalize('NFC'));
  return out;
}

/** deck's own CLI children (this or another deck instance) always carry this argv pair (`claudeArgs`). */
export const DECK_CHILD_MARKER = '--permission-prompt-tool mcp__deck_bridge__permission';

export type HolderSelf = {
  /** deck's own pid: its descendants are not "another" process. */
  pid: number;
};

/**
 * Sessions a `claude` process outside deck has resumed, from `ps -axo pid=,ppid=,command=` output.
 * Such a process keeps its own in-memory history: what it sends next continues from its own last message,
 * whatever deck wrote meanwhile. `desktop` = Claude Desktop's bundled CLI (wins when both kinds hold one
 * session), `other` = anything else (a terminal `claude --resume`). Pure.
 *
 * Only a process that was started to resume a session shows its id. A session started new in Desktop (or by a
 * bare `claude`) has no `--resume` in its arguments: that holder cannot be seen this way and raises no flag.
 */
export function parseHolders(psText: string, self: HolderSelf): Map<string, SessionHolder> {
  const rows: { pid: number; ppid: number; command: string }[] = [];
  for (const line of psText.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]!.normalize('NFC') });
  }
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  // Descendant, not just child: holds if a CLI child is ever started through a wrapper. Bounded against a pid cycle.
  const underDeck = (pid: number) => {
    for (let p: number | undefined = pid, i = 0; p !== undefined && p > 1 && i < 64; p = parent.get(p), i++) if (p === self.pid) return true;
    return false;
  };
  const out = new Map<string, SessionHolder>();
  for (const r of rows) {
    if (!isClaudeCli(r.command) || underDeck(r.pid) || r.command.includes(DECK_CHILD_MARKER)) continue;
    const kind: SessionHolder = r.command.includes('/Claude/claude-code/') || r.command.includes('mcp__ccd_') ? 'desktop' : 'other';
    for (const m of r.command.matchAll(RESUME)) {
      const id = m[1]!.toLowerCase();
      if (kind === 'desktop' || !out.has(id)) out.set(id, kind);
    }
  }
  return out;
}

/** Read-only process list; rejects when `ps` is missing, fails or takes too long. `ww`: commands are never cut short. */
function psList(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-axww', '-o', 'pid=,ppid=,command='], { maxBuffer: 16 * 1024 * 1024, timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** The working dirs of `pids` (read-only `lsof`); rejects on failure. */
function lsofCwds(pids: number[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fn'], { maxBuffer: 4 * 1024 * 1024, timeout: 3000 }, (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout)));
  });
}

/**
 * Which Claude sessions another process holds open, as of the last scan. A scan is at most one `ps` per `ttlMs`
 * (callers ask at every open / send); a failed scan keeps the previous answer — the flag is only a warning.
 */
export class ProcessHolders {
  private held = new Map<string, SessionHolder>();
  private at = -Infinity;
  private scan: Promise<boolean> | null = null;
  private readonly ps: () => Promise<string>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly self: HolderSelf;
  private grok: GrokHolders = { tokens: new Set(), pids: [] };
  private grokCwds = new Set<string>();
  private readonly lsof: (pids: number[]) => Promise<string>;

  constructor(opts: { pid?: number; ps?: () => Promise<string>; ttlMs?: number; now?: () => number; lsof?: (pids: number[]) => Promise<string> } = {}) {
    this.ps = opts.ps ?? psList;
    this.lsof = opts.lsof ?? lsofCwds;
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? 5000;
    this.self = { pid: opts.pid ?? process.pid };
  }

  heldBy(sessionId: string): SessionHolder | null {
    return this.held.get(sessionId.toLowerCase()) ?? null;
  }

  /** A terminal `grok` outside deck has this session id in its arguments: sending from deck too would fork it (refused). */
  grokHeldBy(sessionId: string): SessionHolder | null {
    return this.grok.tokens.has(sessionId) ? 'other' : null;
  }

  /**
   * A `grok` outside deck runs in this folder (which session is unknown): a warning only. lsof reports real paths, so
   * `cwd` is compared as given and as its real path (`/tmp/x` vs `/private/tmp/x`).
   */
  async grokCwdHeld(cwd: string): Promise<boolean> {
    if (!this.grokCwds.size) return false;
    if (this.grokCwds.has(cwd.normalize('NFC'))) return true;
    const real = await fs.realpath(cwd).catch(() => null);
    return real !== null && this.grokCwds.has(real.normalize('NFC'));
  }

  /**
   * Rescans unless the last scan is fresh (`force`: whatever its age — a send to a Grok session decides on it). A scan
   * already in flight is shared. True when a holder came, went or changed kind, or a grok's folder did. Never throws.
   */
  refresh(opts: { force?: boolean } = {}): Promise<boolean> {
    if (this.scan) return this.scan;
    if (!opts.force && this.now() - this.at < this.ttlMs) return Promise.resolve(false);
    // A failed / timed-out `ps` says nothing about who holds what: the last scan's answer stands, "unchanged".
    this.scan = this.ps()
      .then(async (text) => {
        const next = parseHolders(text, this.self);
        const grok = parseGrokHolders(text, this.self);
        // No lsof when no grok runs; a failed lsof means "no folder known" (the cwd match only warns).
        const cwds = grok.pids.length ? parseLsofCwds(await this.lsof(grok.pids).catch(() => '')) : new Set<string>();
        const differ = (a: Set<string>, b: Set<string>) => a.size !== b.size || [...a].some((t) => !b.has(t));
        const changed = next.size !== this.held.size || [...next].some(([id, kind]) => this.held.get(id) !== kind)
          || differ(grok.tokens, this.grok.tokens) || differ(cwds, this.grokCwds);
        this.held = next;
        this.grok = grok;
        this.grokCwds = cwds;
        return changed;
      })
      .catch(() => false)
      .finally(() => { this.at = this.now(); this.scan = null; });
    return this.scan;
  }
}
