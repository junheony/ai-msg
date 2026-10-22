import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';

/**
 * §14.1-2 · §14.9-2: before every Grok spawn, `grok inspect --json` runs with the turn's env, cwd and shadow HOME, and
 * the turn starts only when nothing can make Grok skip deck's approvals.
 *
 * Observed (grok 1.0.62, fixtures `acp/fixtures/grok-1.0.62/inspect.*.json`): `permissions.sources` (array of
 * "<path> (settings)") and `permissions.loaded` (rule count) show Claude settings rules; there is no defaultMode or
 * auto-mode field, so the config layers inspect lists (`configSources.layers[].path`, Grok's config.toml) are read
 * for `permission_mode` / `auto_mode` / yolo keys. A missing field = fail-closed. A future `permissions.defaultMode`
 * must be absent or `default`. Also refused: loaded hooks / MCP servers / plugins, active managed settings, no config
 * layer, and external-compat cells that could load hooks or MCP servers (checkExternalCompat).
 */

type Rec = Record<string, unknown>;

export const grokInspectRefusal = (item: string) => `Grok 설정(~/.grok/config.toml)의 권한 기본값이 자동이라 AI-MSG 승인을 보장할 수 없음 — ${item}`;

export type GrokInspectVerdict = { ok: true } | { ok: false; item: string };

const obj = (x: unknown): Rec | null => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Rec) : null);

/** Strips a `#` comment outside quotes. */
function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, '$2');
const keyPath = (k: string) => k.split('.').map((s) => unquote(s).trim().toLowerCase()).filter(Boolean);

/** The top-level `k = v` entries of a one-line inline table `{ … }`; null when it cannot be read (unbalanced, trailing text). */
function inlineEntries(value: string): string[] | null {
  if (!value.startsWith('{')) return null;
  const parts: string[] = [];
  let q: string | null = null;
  let depth = 0;
  let start = 1;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        if (i !== value.length - 1 || c !== '}') return null;
        parts.push(value.slice(start, i));
      }
    } else if (c === ',' && depth === 1) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  if (q || depth !== 0) return null;
  const out = parts.map((p) => p.trim());
  if (out.length === 1 && out[0] === '') return [];
  return out.every((p) => p.includes('=')) ? out : null;
}

/** One key (full dotted path) and its raw value; an inline table is checked entry by entry. */
function checkEntry(full: string[], value: string): GrokInspectVerdict {
  const name = full.join('.');
  if (value.startsWith('{')) {
    const entries = inlineEntries(value);
    if (!entries) return { ok: false, item: `${name} = ${value} (인라인 테이블을 읽을 수 없음)` };
    for (const e of entries) {
      const eq = e.indexOf('=');
      const v = checkEntry([...full, ...keyPath(e.slice(0, eq))], e.slice(eq + 1).trim());
      if (!v.ok) return v;
    }
    return { ok: true };
  }
  const v = unquote(value).toLowerCase();
  const last = full.at(-1) ?? '';
  if ((last === 'permission_mode' || last === 'default_mode' || last === 'defaultmode' || last === 'permissionmode') && v !== 'default') return { ok: false, item: `${name} = ${value}` };
  if (full.includes('auto_mode') || full.includes('automode')) {
    if (last === 'enabled' && v !== 'false') return { ok: false, item: `${name} = ${value}` };
    if ((last === 'auto_mode' || last === 'automode') && v !== 'false') return { ok: false, item: `${name} = ${value}` };
  }
  if (/^yolo(_mode)?$|^yolomode$|^always_approve$|^bypass_permissions$/.test(last) && v !== 'false') return { ok: false, item: `${name} = ${value}` };
  return { ok: true };
}

/**
 * Scans one TOML config for settings that turn Grok's approvals off by default. Conservative on purpose: a key it
 * names with any value other than the safe one is a refusal (a value it cannot read included); an inline table is read
 * inside, and one it cannot read is a refusal.
 */
export function checkGrokConfigToml(text: string): GrokInspectVerdict {
  let table: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const t = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (t) { table = keyPath(t[1]!); continue; }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const v = checkEntry([...table, ...keyPath(line.slice(0, eq))], line.slice(eq + 1).trim());
    if (!v.ok) return v;
  }
  return { ok: true };
}

/**
 * §14.9-2 external compat (`externalCompat.cells`, grok 1.0.62): Claude's cells are switched off by deck's env
 * (GROK_CLAUDE_*_ENABLED=false), so a Claude hooks/MCP cell that is on means the env did not take. No env or flag that
 * switches Cursor's cells off is known, and they are on by default (`source: "default"`, the clean fixture): that is
 * accepted only because nothing can feed them — the shadow HOME has no `~/.cursor` and the project guard refuses any
 * `.cursor/` from the cwd up — and inspect's own `hooks` / `mcpServers` lists must be empty. A Cursor hooks/MCP cell
 * switched on by anything else (config, env, remote), any other vendor's hooks/MCP cell on, or a cell deck cannot read
 * is a refusal. Rules cells are judged like other rules (permissions.sources / loaded above).
 */
function checkExternalCompat(ec: Rec | null): GrokInspectVerdict {
  if (!ec) return { ok: false, item: 'inspect 결과에 externalCompat 없음' };
  if (ec.remoteSettingsLoaded !== false) return { ok: false, item: `externalCompat.remoteSettingsLoaded = ${JSON.stringify(ec.remoteSettingsLoaded)}` };
  if (!Array.isArray(ec.cells)) return { ok: false, item: 'inspect 결과에 externalCompat.cells 없음' };
  for (const raw of ec.cells) {
    const c = obj(raw);
    if (!c || typeof c.vendor !== 'string' || typeof c.surface !== 'string' || typeof c.enabled !== 'boolean') return { ok: false, item: `읽을 수 없는 외부 호환 항목: ${JSON.stringify(raw)?.slice(0, 120)}` };
    if (!c.enabled || (c.surface !== 'hooks' && c.surface !== 'mcps')) continue;
    if (c.vendor === 'cursor' && c.source === 'default') continue;
    return { ok: false, item: `외부 호환 ${c.vendor} ${c.surface} 켜짐 (source ${JSON.stringify(c.source)})` };
  }
  return { ok: true };
}

/** The verdict for one `grok inspect --json` result. `readText` reads a config layer (ENOENT = no layer). */
export async function checkGrokInspect(json: unknown, readText: (p: string) => Promise<string> = (p) => fs.readFile(p, 'utf8')): Promise<GrokInspectVerdict> {
  const root = obj(json);
  const perms = obj(root?.permissions);
  if (!root || !perms) return { ok: false, item: 'inspect 결과에 permissions 없음' };
  if (!Array.isArray(perms.sources)) return { ok: false, item: 'inspect 결과에 permissions.sources 없음' };
  if (typeof perms.loaded !== 'number') return { ok: false, item: 'inspect 결과에 permissions.loaded 없음' };
  if (perms.sources.length > 0 || perms.loaded > 0) {
    const names = perms.sources.filter((s): s is string => typeof s === 'string').slice(0, 3).join(', ');
    return { ok: false, item: `권한 규칙 출처 ${perms.sources.length}개 · 규칙 ${perms.loaded}개${names ? ` (${names})` : ''}` };
  }
  if (perms.managedSettingsActive !== false) return { ok: false, item: `permissions.managedSettingsActive = ${JSON.stringify(perms.managedSettingsActive)}` };
  // Hooks, MCP servers and plugins run code before (or around) any card: anything listed, or a list deck cannot read, refuses.
  for (const k of ['hooks', 'mcpServers', 'plugins']) {
    const v = root[k];
    if (!Array.isArray(v)) return { ok: false, item: `inspect 결과에 ${k} 목록 없음` };
    if (v.length > 0) return { ok: false, item: `${k} ${v.length}개 로드됨` };
  }
  const compat = checkExternalCompat(obj(root.externalCompat));
  if (!compat.ok) return compat;
  for (const holder of [perms, root]) {
    for (const k of ['defaultMode', 'permissionMode']) {
      if (holder[k] !== undefined && holder[k] !== null && holder[k] !== 'default') return { ok: false, item: `${k} = ${JSON.stringify(holder[k])}` };
    }
    for (const k of ['autoMode', 'yoloMode', 'yolo']) {
      const v = holder[k];
      if (v !== undefined && v !== null && v !== false && !(obj(v) && obj(v)!.enabled === false)) return { ok: false, item: `${k} = ${JSON.stringify(v)}` };
    }
  }
  const layers = obj(root.configSources)?.layers;
  if (!Array.isArray(layers) || layers.length === 0) return { ok: false, item: 'inspect 결과에 configSources.layers 없음' };
  for (const layer of layers) {
    const p = obj(layer)?.path;
    if (typeof p !== 'string' || !p) return { ok: false, item: 'inspect 결과의 설정 층에 경로 없음' };
    let text: string;
    try {
      text = await readText(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return { ok: false, item: `설정 파일을 읽을 수 없음: ${p}` };
    }
    const v = checkGrokConfigToml(text);
    if (!v.ok) return v;
  }
  return { ok: true };
}

/** Runs `grok inspect --json` once with the turn's env and cwd; throws on a failed run or non-JSON output. */
export function runGrokInspect(bin: string, env: Record<string, string>, cwd: string, timeoutMs = 20_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['inspect', '--json'], { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) { reject(new Error(`grok inspect 실패: ${err.message.split('\n')[0]!.slice(0, 200)}`)); return; }
      try { resolve(JSON.parse(String(stdout))); } catch { reject(new Error('grok inspect 출력이 JSON 이 아님')); }
    });
  });
}
