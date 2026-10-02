import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export type MoveResult =
  | { ok: true; targetDir: string; targetFile: string; copied: string[] }
  | { ok: false; error: string; diverged?: true };

export async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** Relative path → sha256 for every regular file under `dir`. */
async function hashTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const e of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const p = path.join(e.parentPath, e.name);
    out.set(path.relative(dir, p), await sha256File(p));
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** True when every byte of `prefixFile` equals the start of `fullFile`. */
export async function isBytePrefix(prefixFile: string, fullFile: string): Promise<boolean> {
  const [a, b] = await Promise.all([fs.open(prefixFile, 'r'), fs.open(fullFile, 'r')]);
  try {
    const [sa, sb] = await Promise.all([a.stat(), b.stat()]);
    if (sa.size > sb.size) return false;
    const CHUNK = 1 << 20;
    const ba = Buffer.alloc(CHUNK);
    const bb = Buffer.alloc(CHUNK);
    for (let pos = 0; pos < sa.size; pos += CHUNK) {
      const n = Math.min(CHUNK, sa.size - pos);
      const [ra, rb] = await Promise.all([a.read(ba, 0, n, pos), b.read(bb, 0, n, pos)]);
      if (ra.bytesRead !== n || rb.bytesRead !== n || !ba.subarray(0, n).equals(bb.subarray(0, n))) return false;
    }
    return true;
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
}

/** Project dirs under `projectsRoot` (other than `targetDir`) that already hold `<id>.jsonl`. */
async function findDuplicates(projectsRoot: string, sessionId: string, targetDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(projectsRoot);
  } catch {
    return [];
  }
  const targetStat = await fs.stat(targetDir).catch(() => null);
  const out: string[] = [];
  for (const name of names) {
    const dir = path.join(projectsRoot, name);
    if (!(await exists(path.join(dir, `${sessionId}.jsonl`)))) continue;
    const st = await fs.stat(dir);
    // Compare by inode: on APFS an NFC/NFD spelling of the same name is the same directory.
    if (targetStat && st.dev === targetStat.dev && st.ino === targetStat.ino) continue;
    out.push(name);
  }
  return out;
}

/**
 * Spec §7/§8: copy a session (jsonl + `<id>/` companions) into another profile's
 * projects root under the same directory name, verify, and never write the source.
 * `ignoreOtherDirs`: skip the M12 check — for the home write-back, which only refreshes the
 * same-named copy and leaves a stale copy in a differently spelled dir untouched.
 */
export async function moveSession(opts: { sessionId: string; sourceProjectDir: string; targetProjectsRoot: string; ignoreOtherDirs?: boolean }): Promise<MoveResult> {
  const { sessionId } = opts;
  const srcFile = path.join(opts.sourceProjectDir, `${sessionId}.jsonl`);
  const srcDir = path.join(opts.sourceProjectDir, sessionId);
  const targetDir = path.join(opts.targetProjectsRoot, path.basename(opts.sourceProjectDir));
  const targetFile = path.join(targetDir, `${sessionId}.jsonl`);
  const tmpFile = `${targetFile}.deck-tmp`;
  const tmpDir = path.join(targetDir, `${sessionId}.deck-tmp`);

  if (path.resolve(targetDir) === path.resolve(opts.sourceProjectDir)) {
    return (await exists(srcFile)) ? { ok: true, targetDir, targetFile, copied: [] } : { ok: false, error: `원본 없음: ${srcFile}` };
  }

  const finalDir = path.join(targetDir, sessionId);
  const bakDir = path.join(targetDir, `${sessionId}.deck-bak-${Date.now()}`);
  let movedOld = false;
  let installedNew = false;
  let committed = false;
  let diverged = false;
  try {
    const srcStat = await fs.stat(srcFile);
    const srcHash = await sha256File(srcFile);

    // M12: the same id in another directory of this profile — which one resume picks is unverified.
    const dups = opts.ignoreOtherDirs ? [] : await findDuplicates(opts.targetProjectsRoot, sessionId, targetDir);
    if (dups.length) throw new Error(`대상 프로필의 다른 디렉터리에 같은 세션이 있음: ${dups.join(', ')}`);

    // Sessions are append-only: an older deck copy is always a byte-prefix. Anything else diverged.
    if ((await exists(targetFile)) && !(await isBytePrefix(targetFile, srcFile))) {
      diverged = true;
      throw new Error('대상 세션이 따로 진행됨(원본의 앞부분이 아님) — 덮어쓰지 않음');
    }

    await fs.mkdir(targetDir, { recursive: true });
    const copied: string[] = [`${sessionId}.jsonl`];

    // Stage 1: jsonl.
    await fs.rm(tmpFile, { force: true });
    await fs.copyFile(srcFile, tmpFile);
    const tmpStat = await fs.stat(tmpFile);
    if (tmpStat.size !== srcStat.size || (await sha256File(tmpFile)) !== srcHash) {
      throw new Error('복사본 검증 실패(jsonl 해시 불일치)');
    }

    // Stage 2: companions (source wins; files only on the target are merged in so nothing is lost).
    const hasCompanions = await exists(srcDir);
    let conflict = false;
    if (hasCompanions) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.cp(srcDir, tmpDir, { recursive: true, errorOnExist: false });
      const srcTree = await hashTree(srcDir);
      const tmpTree = await hashTree(tmpDir);
      if (tmpTree.size !== srcTree.size || [...srcTree].some(([k, h]) => tmpTree.get(k) !== h)) {
        throw new Error('복사본 검증 실패(부속 파일 불일치)');
      }
      if (await exists(finalDir)) {
        for (const [rel, h] of await hashTree(finalDir)) {
          const staged = tmpTree.get(rel);
          if (staged === undefined) {
            await fs.mkdir(path.dirname(path.join(tmpDir, rel)), { recursive: true });
            await fs.copyFile(path.join(finalDir, rel), path.join(tmpDir, rel));
          } else if (staged !== h) {
            conflict = true;
          }
        }
      }
      copied.push(`${sessionId}/`);
    }

    // Everything staged and verified; the source must still be the snapshot we copied.
    const nowStat = await fs.stat(srcFile);
    if (nowStat.size !== srcStat.size || (await sha256File(srcFile)) !== srcHash) throw new Error('원본이 복사 중 바뀜');

    // Commit: companions first, jsonl LAST (the final rename is the commit point).
    if (hasCompanions) {
      if (await exists(finalDir)) {
        await fs.rename(finalDir, bakDir);
        movedOld = true;
      }
      await fs.rename(tmpDir, finalDir);
      installedNew = true;
    }
    await fs.rename(tmpFile, targetFile);
    committed = true;

    // The old companion dir is only dropped when every file in it survives unchanged in the new one.
    if (movedOld && !conflict) await fs.rm(bakDir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: true, targetDir, targetFile, copied };
  } catch (err) {
    if (!committed) {
      if (installedNew) await fs.rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
      if (movedOld) await fs.rename(bakDir, finalDir).catch(() => undefined);
    }
    await fs.rm(tmpFile, { force: true }).catch(() => undefined);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: err instanceof Error ? err.message : String(err), ...(diverged ? { diverged: true as const } : {}) };
  }
}
