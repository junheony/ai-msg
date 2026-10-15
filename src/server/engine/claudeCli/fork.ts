// src/server/engine/claudeCli/fork.ts
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { projectSlug } from '../../sessions/slug';
import { FORK_AT_UNSUPPORTED, FORK_SOURCE_MISSING } from './texts';

type Entry = { uuid?: unknown; parentUuid?: unknown; logicalParentUuid?: unknown };

/**
 * 메시지 편집 갈래 without `resumeSessionAt`: the transcript lines that make up the conversation up to and
 * including entry `at` — its ancestor chain (parentUuid, or logicalParentUuid across a compact boundary) in file
 * order, plus uuid-less metadata lines (summary, title) that come before `at`. Null when `at` is not in the lines.
 */
export function chainUpTo(lines: string[], at: string): string[] | null {
  const parsed = lines.map((line) => { try { const r = JSON.parse(line) as unknown; return r && typeof r === 'object' ? (r as Entry) : null; } catch { return null; } });
  const parent = new Map<string, string | null>();
  for (const r of parsed) {
    if (r && typeof r.uuid === 'string') {
      const p = typeof r.parentUuid === 'string' ? r.parentUuid : typeof r.logicalParentUuid === 'string' ? r.logicalParentUuid : null;
      parent.set(r.uuid, p);
    }
  }
  if (!parent.has(at)) return null;
  const keep = new Set<string>();
  for (let u: string | null | undefined = at, i = 0; u && !keep.has(u) && i < 1_000_000; u = parent.get(u), i++) keep.add(u);
  const atIndex = parsed.findIndex((r) => r?.uuid === at);
  const out: string[] = [];
  parsed.forEach((r, i) => {
    if (!r || i > atIndex) return;
    if (typeof r.uuid === 'string' ? keep.has(r.uuid) : true) out.push(lines[i]!);
  });
  return out;
}

/** Where the CLI keeps `sessionId`'s transcript for `cwd` in one profile: slug of cwd and its realpath, NFC and NFD. */
export function forkCandidates(projectsDir: string, cwd: string, sessionId: string, realpath: (p: string) => string = realpathSync): string[] {
  let real = cwd;
  try { real = realpath(cwd); } catch { /* cwd gone: the plain slug only */ }
  const out: string[] = [];
  for (const p of [cwd, real]) for (const form of [p.normalize('NFC'), p.normalize('NFD')]) {
    const f = path.join(projectsDir, projectSlug(form), `${sessionId}.jsonl`);
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

export type ForkSource = { ok: true; path: string } | { ok: false; text: string };

/**
 * Writes the truncated parent transcript to `<dir>/<sessionId>.jsonl.fork/<sessionId>.jsonl` (0600; `dir` is the
 * process's 0700 temp dir, removed after the turn) for `--resume=<path> --fork-session`. The file keeps the
 * parent's name so its entries' `sessionId` match the file they are in. The parent transcript is only read.
 * The subdirectory keeps the source from ever overwriting a candidate that happens to sit in `dir`.
 */
export async function writeForkSource(o: { candidates: string[]; at: string; dir: string; sessionId: string; readFile?: (p: string) => Promise<string> }): Promise<ForkSource> {
  const read = o.readFile ?? ((p: string) => fs.readFile(p, 'utf8'));
  let text: string | null = null;
  for (const c of o.candidates) {
    try { text = await read(c); break; } catch { /* next candidate */ }
  }
  if (text === null) return { ok: false, text: FORK_SOURCE_MISSING };
  const kept = chainUpTo(text.split('\n').filter((l) => l.trim()), o.at);
  if (!kept) return { ok: false, text: FORK_AT_UNSUPPORTED };
  const sub = path.join(o.dir, `${o.sessionId}.jsonl.fork`);
  await fs.mkdir(sub, { mode: 0o700, recursive: true });
  const file = path.join(sub, `${o.sessionId}.jsonl`);
  await fs.writeFile(file, kept.join('\n') + '\n', { mode: 0o600 });
  return { ok: true, path: file };
}
