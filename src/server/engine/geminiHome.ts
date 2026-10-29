import fs from 'node:fs';
import path from 'node:path';
import { geminiSeatHome, type GeminiAccount } from '../../shared/accounts';
import { GROK_SHADOW_LINKS, SHADOW_FORBIDDEN } from './shadowHome';

/**
 * g2's agy state has to survive across turns (a per-turn shadow home deletes `~/.gemini`). This makes
 * `~/.agy-g2` once: mode 0700, a real directory owned by this user, with the same git/ssh links a Grok shadow
 * gets. It never links `.gemini` or anything in `SHADOW_FORBIDDEN`. g1 is the real home and is left alone.
 */
export function ensureGeminiSeatHome(account: GeminiAccount, realHome: string): { ok: true; home: string } | { ok: false; error: string } {
  const home = geminiSeatHome(account, realHome);
  if (account === 'g1') return { ok: true, home };
  try {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(home);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, error: 'Gemini 2 홈을 확인하지 못했습니다' };
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      fs.chmodSync(home, 0o700);
      st = fs.lstatSync(home);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, error: 'Gemini 2 홈이 폴더가 아닙니다' };
    const me = typeof process.getuid === 'function' ? process.getuid() : null;
    if (me !== null && st.uid !== me) return { ok: false, error: 'Gemini 2 홈의 소유자가 다릅니다' };
    if ((st.mode & 0o777) !== 0o700) {
      fs.chmodSync(home, 0o700);
      st = fs.lstatSync(home);
      if ((st.mode & 0o777) !== 0o700) return { ok: false, error: 'Gemini 2 홈 권한을 0700 으로 맞출 수 없습니다' };
    }
    for (const rel of GROK_SHADOW_LINKS) {
      const norm = rel.split(path.sep).join('/');
      if (SHADOW_FORBIDDEN.some((f) => norm === f || norm.startsWith(`${f}/`))) continue;
      const src = path.join(realHome, rel);
      let srcSt: fs.Stats;
      try { srcSt = fs.lstatSync(src); } catch { continue; }
      if (!srcSt) continue;
      const dst = path.join(home, rel);
      try { fs.lstatSync(dst); continue; } catch { /* missing: link it */ }
      const parent = path.dirname(dst);
      if (parent !== home) fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      fs.symlinkSync(src, dst);
    }
    return { ok: true, home };
  } catch {
    return { ok: false, error: 'Gemini 2 홈을 준비하지 못했습니다' };
  }
}
