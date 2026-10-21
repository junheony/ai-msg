import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// In the bundle this module is inlined into dist/server/app.js, so `here` is dist/server (next to hookRelay.js);
// in the repo it is src/server/engine/claudeCli (next to hookRelay.ts).
const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The script `node` runs for a Claude child: the bundled `.js` first (Node refuses to strip types under node_modules),
 * else the `.ts` source (repo run). Neither → throws.
 */
export function childScript(name: 'hookRelay' | 'permissionMcp', here: string = HERE, exists: (p: string) => boolean = fs.existsSync): string {
  for (const ext of ['.js', '.ts']) {
    const p = path.join(here, name + ext);
    if (exists(p)) return p;
  }
  throw new Error(`deck: Claude 자식 스크립트 ${name}(.js/.ts)를 ${here} 에서 찾지 못했습니다`);
}

const SNAPSHOT_RE = /^[0-9A-Za-z._+-]+-[0-9a-f]{8}$/;

/**
 * S7: a bundled run copies both scripts to `<runDir>/<version>-<content hash 8>/` (reused when already there) so an
 * upgrade that replaces the package files under a running server does not swap a live child's script. A repo run
 * (`.ts`) keeps the originals. Other snapshot folders in `runDir` go (folders only — files like children.json stay).
 */
export function snapshotChildScripts(o: { src: string; runDir: string; version: string }): { hookRelay: string; permissionMcp: string } {
  const orig = { hookRelay: childScript('hookRelay', o.src), permissionMcp: childScript('permissionMcp', o.src) };
  if (!orig.hookRelay.endsWith('.js') || !orig.permissionMcp.endsWith('.js')) return orig;
  const hash = createHash('sha256');
  for (const f of [orig.hookRelay, orig.permissionMcp]) hash.update(fs.readFileSync(f)).update('\0');
  const name = `${o.version.replace(/[^0-9A-Za-z._+-]/g, '_')}-${hash.digest('hex').slice(0, 8)}`;
  const dir = path.join(o.runDir, name);
  const out = { hookRelay: path.join(dir, 'hookRelay.js'), permissionMcp: path.join(dir, 'permissionMcp.js') };
  if (!fs.existsSync(out.hookRelay) || !fs.existsSync(out.permissionMcp)) {
    fs.mkdirSync(o.runDir, { recursive: true, mode: 0o700 });
    const tmp = fs.mkdtempSync(path.join(o.runDir, '.snap-'));
    fs.copyFileSync(orig.hookRelay, path.join(tmp, 'hookRelay.js'));
    fs.copyFileSync(orig.permissionMcp, path.join(tmp, 'permissionMcp.js'));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
  }
  for (const e of fs.readdirSync(o.runDir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name !== name && (SNAPSHOT_RE.test(e.name) || e.name.startsWith('.snap-'))) fs.rmSync(path.join(o.runDir, e.name), { recursive: true, force: true });
  }
  return out;
}
