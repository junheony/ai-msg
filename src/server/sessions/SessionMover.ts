import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export type MoveResult =
  | { ok: true; targetDir: string; targetFile: string; copied: string[] }
  | { ok: false; error: string };

export async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

async function countFiles(dir: string): Promise<number> {
  let n = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += await countFiles(path.join(dir, e.name));
    else n += 1;
  }
  return n;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spec §7/§8: copy a session (jsonl + `<id>/` companions) into another profile's
 * projects root under the same directory name, verify, and never write the source.
 */
export async function moveSession(opts: { sessionId: string; sourceProjectDir: string; targetProjectsRoot: string }): Promise<MoveResult> {
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

  try {
    const srcStat = await fs.stat(srcFile);
    const srcHash = await sha256File(srcFile);
    await fs.mkdir(targetDir, { recursive: true });
    const copied: string[] = [];

    await fs.copyFile(srcFile, tmpFile);
    const tmpStat = await fs.stat(tmpFile);
    if (tmpStat.size !== srcStat.size || (await sha256File(tmpFile)) !== srcHash) {
      throw new Error('복사본 검증 실패(jsonl 해시 불일치)');
    }
    await fs.rename(tmpFile, targetFile);
    copied.push(`${sessionId}.jsonl`);

    if (await exists(srcDir)) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.cp(srcDir, tmpDir, { recursive: true, errorOnExist: false });
      if ((await countFiles(tmpDir)) !== (await countFiles(srcDir))) throw new Error('복사본 검증 실패(부속 파일 수 불일치)');
      await fs.rm(path.join(targetDir, sessionId), { recursive: true, force: true });
      await fs.rename(tmpDir, path.join(targetDir, sessionId));
      copied.push(`${sessionId}/`);
    }

    if ((await sha256File(srcFile)) !== srcHash) throw new Error('원본이 복사 중 바뀜');
    return { ok: true, targetDir, targetFile, copied };
  } catch (err) {
    await fs.rm(tmpFile, { force: true }).catch(() => undefined);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
