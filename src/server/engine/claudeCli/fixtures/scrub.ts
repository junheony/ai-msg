// Dev-only: turns a raw `claude -p --output-format stream-json` capture into a committable fixture.
// Usage: npx tsx src/server/engine/claudeCli/fixtures/scrub.ts --home "$HOME" --cwd <capture dir> < raw > out
import fs from 'node:fs';
import readline from 'node:readline';

const BUILTIN_COMMANDS = new Set(['compact', 'context', 'cost', 'init', 'review', 'clear', 'help', 'model', 'memory']);
const DROPPED_SYSTEM = new Set(['hook_started', 'hook_progress', 'hook_response', 'informational']);
const slug =(p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function variants(p: string): string[] {
  const out = new Set([p]);
  try { out.add(fs.realpathSync(p)); } catch { /* temp dir already gone */ }
  if (p.startsWith('/var/')) out.add(`/private${p}`);
  return [...out].sort((a, b) => b.length - a.length);
}

function scrubText(s: string, ctx: { home: string; cwd: string }): string {
  let out = s;
  for (const c of variants(ctx.cwd)) {
    out = out.replace(new RegExp(escape(c), 'g'), '/work').replace(new RegExp(escape(slug(c)), 'g'), '-work');
  }
  for (const h of variants(ctx.home)) {
    out = out.replace(new RegExp(escape(h), 'g'), '/home/user').replace(new RegExp(escape(slug(h)), 'g'), '-home-user');
  }
  return out
    // A profile picked with CLAUDE_CONFIG_DIR (~/.claude-<name>): the name is private.
    .replace(/\/home\/user\/\.claude-[A-Za-z0-9_.-]+/g, '/home/user/.claude')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'user@example.invalid')
    .replace(/[A-Za-z0-9-]+\.[A-Za-z0-9-]+\.ts\.net/g, 'host.invalid');
}

export function scrubLine(line: string, ctx: { home: string; cwd: string }): string {
  const text = scrubText(line, ctx);
  let m: Record<string, unknown>;
  try { m = JSON.parse(text) as Record<string, unknown>; } catch { return text; }
  // The capturing profile's own hooks (their output, and the notices they print) are private and not deck's: dropped.
  if (m.type === 'system' && typeof m.subtype === 'string' && DROPPED_SYSTEM.has(m.subtype)) return '';
  if (m.type === 'system' && m.subtype === 'init') {
    if (Array.isArray(m.tools)) m.tools = m.tools.filter((t) => typeof t === 'string' && (!t.startsWith('mcp__') || t.startsWith('mcp__deck_bridge__')));
    if (Array.isArray(m.slash_commands)) m.slash_commands = m.slash_commands.filter((c) => typeof c === 'string' && BUILTIN_COMMANDS.has(c));
    if (Array.isArray(m.mcp_servers)) m.mcp_servers = m.mcp_servers.filter((s) => (s as { name?: unknown })?.name === 'deck_bridge');
    for (const k of ['skills', 'plugins', 'agents']) if (Array.isArray(m[k])) m[k] = [];
  }
  return JSON.stringify(m);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] ?? '' : ''; };
  const ctx = { home: arg('--home'), cwd: arg('--cwd') };
  if (!ctx.home || !ctx.cwd) { console.error('usage: scrub.ts --home <dir> --cwd <dir> < raw > out'); process.exit(2); }
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (l) => { const out = l.trim() ? scrubLine(l, ctx) : ''; if (out) process.stdout.write(out + '\n'); });
}
