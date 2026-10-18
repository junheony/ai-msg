import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 편집 자동 on a Grok session (§14.1-3, §14.9-4): deck answers an `edit` permission request itself only when every
 * path the request names resolves inside the session cwd and none is on the deny list. Anything it cannot resolve,
 * or any doubt, is a card.
 */

type Rec = Record<string, unknown>;

/** Directory names: anything at or under one of these is always a card. Compared after NFC + lower case. */
const DENY_DIRS = new Set(['.git', '.claude', '.grok', '.cursor', '.vscode', '.idea', '.husky', '.githooks']);
/** File names that are always a card (`.env*` is matched by prefix). */
const DENY_FILES = new Set(['.gitmodules', '.envrc', '.mcp.json']);

const fold = (s: string) => s.normalize('NFC').toLowerCase();

/** True when a path relative to the cwd hits the deny list. */
export function isEditDenied(rel: string): boolean {
  const segs = rel.split(/[\\/]+/).filter(Boolean).map(fold);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (DENY_DIRS.has(s)) return true;
    if (s === 'node_modules' && segs[i + 1] === '.bin') return true;
  }
  const base = segs.at(-1) ?? '';
  return DENY_FILES.has(base) || base.startsWith('.env');
}

const PATH_KEYS = ['file_path', 'filePath', 'path', 'target_file', 'targetFile', 'old_path', 'new_path', 'oldPath', 'newPath', 'source', 'destination', 'from', 'to', 'src', 'dst', 'notebook_path'];
const PATCH_KEYS = ['patch', 'diff', 'input', 'patch_text', 'patchText'];
const PATCH_LINE = /^(?:\*\*\* (?:Add|Update|Delete) File: |\*\*\* Move to: |--- (?:a\/)?|\+\+\+ (?:b\/)?|rename (?:from|to) )(.+)$/;

/**
 * Every path a permission request names: `locations[].path`, diff content paths, rawInput path fields (both ends of a
 * move), list fields of those, and each file of a patch body. `null` = something path-like could not be read.
 */
export function collectEditPaths(toolCall: Rec, known?: { rawInput?: unknown; locations?: unknown }): string[] | null {
  const out: string[] = [];
  let bad = false;
  const add = (x: unknown) => { if (typeof x === 'string' && x) out.push(x); else bad = true; };
  for (const locs of [toolCall.locations, known?.locations]) {
    if (!Array.isArray(locs)) continue;
    for (const l of locs) add(l && typeof l === 'object' ? (l as Rec).path : undefined);
  }
  if (Array.isArray(toolCall.content)) {
    for (const c of toolCall.content) if (c && typeof c === 'object' && (c as Rec).type === 'diff') add((c as Rec).path);
  }
  const walkInput = (raw: unknown, depth: number) => {
    if (!raw || typeof raw !== 'object') return;
    if (depth > 3) { bad = true; return; }
    if (Array.isArray(raw)) { for (const x of raw) walkInput(x, depth + 1); return; }
    const r = raw as Rec;
    for (const k of PATH_KEYS) {
      const v = r[k];
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach(add);
      else if (typeof v === 'object') walkInput(v, depth + 1);
      else add(v);
    }
    for (const k of ['paths', 'files']) if (Array.isArray(r[k])) for (const v of r[k] as unknown[]) typeof v === 'string' ? add(v) : walkInput(v, depth + 1);
    for (const k of ['edits', 'changes', 'operations']) if (Array.isArray(r[k])) walkInput(r[k], depth + 1);
    for (const k of PATCH_KEYS) {
      const v = r[k];
      if (typeof v !== 'string' || !v.includes('\n')) continue;
      for (const line of v.split(/\r?\n/)) {
        const m = PATCH_LINE.exec(line);
        if (m && m[1]!.trim() !== '/dev/null') add(m[1]!.trim());
      }
    }
  };
  walkInput(toolCall.rawInput, 0);
  if (known?.rawInput !== undefined && known.rawInput !== toolCall.rawInput) walkInput(known.rawInput, 0);
  if (bad) return null;
  return [...new Set(out)];
}

/** realpath of `p`, or of its nearest existing ancestor joined with the rest (a new file). Null when nothing resolves. */
async function resolveReal(p: string): Promise<{ real: string; existing: boolean } | null> {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    const st = await fs.lstat(cur).catch(() => null);
    if (st) {
      const real = await fs.realpath(cur).catch(() => null);
      if (!real) return null;
      return { real: rest.length ? path.join(real, ...rest.reverse()) : real, existing: rest.length === 0 };
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    rest.push(path.basename(cur));
    cur = parent;
  }
}

const inside = (root: string, p: string) => p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * True only when deck may answer this edit request itself. `cwd` and `home` are real paths. Off when the cwd is `/`,
 * HOME, an ancestor of HOME, or inside a denied folder.
 */
export async function editAutoAllowed(opts: { cwd: string; home: string; toolCall: Rec; known?: { rawInput?: unknown; locations?: unknown } }): Promise<boolean> {
  const { cwd, home } = opts;
  if (cwd === path.parse(cwd).root || cwd === home || inside(cwd, home)) return false;
  if (cwd.split(path.sep).some((s) => DENY_DIRS.has(fold(s)))) return false;
  const paths = collectEditPaths(opts.toolCall, opts.known);
  if (!paths || paths.length === 0) return false;
  for (const p of paths) {
    // A shell-style path (~, $VAR) or a URL / drive form (`file:`, `C:`) may not mean what path.resolve makes of it.
    if (p.includes('\0') || p.startsWith('~') || p.includes('$') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(p)) return false;
    const abs = path.resolve(cwd, p);
    const lexRel = path.relative(cwd, abs);
    if (!lexRel || lexRel.startsWith('..') || path.isAbsolute(lexRel) || isEditDenied(lexRel)) return false;
    const r = await resolveReal(abs);
    if (!r || !inside(cwd, r.real)) return false;
    if (isEditDenied(path.relative(cwd, r.real))) return false;
    if (r.existing) {
      const st = await fs.stat(r.real).catch(() => null);
      if (!st || (st.isFile() && st.nlink > 1)) return false;
    }
  }
  return true;
}
