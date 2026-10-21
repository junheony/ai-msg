import path from 'node:path';
import { SERVICE_TEXTS as T } from '../../setup/texts';

const VERSION_MANAGERS = ['/.nvm/versions/', '/fnm/node-versions/', '/.fnm/', '/.volta/tools/image/', '/.asdf/installs/', '/mise/installs/', '/n/versions/'];
const CELLAR_RE = /^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/;

const major = (v: string | null) => {
  const m = /^v?(\d+)\./.exec(v ?? '');
  return m ? Number(m[1]) : null;
};

/**
 * The node a service should run: `--node` as given (must run and be ≥ 24); a Homebrew Cellar path → the opt/bin symlink
 * with the same real path; a version manager's node → refused; anything else as it is. darwin adds the TCC warning.
 */
export async function stableNodePath(o: {
  execPath: string; explicit?: string; platform?: NodeJS.Platform;
  realpath: (p: string) => string; exists: (p: string) => boolean; nodeVersion: (bin: string) => Promise<string | null>;
}): Promise<{ node: string; warning?: string } | { error: string }> {
  const warn = (o.platform ?? process.platform) === 'darwin' ? { warning: T.nodeTcc } : {};
  if (o.explicit) {
    const p = path.resolve(o.explicit);
    if (!o.exists(p)) return { error: T.nodeMissing(p) };
    const v = await o.nodeVersion(p);
    const m = major(v);
    if (m === null) return { error: T.nodeMissing(p) };
    if (m < 24) return { error: T.nodeOld(p, v!) };
    return { node: p, ...warn };
  }
  let real: string;
  try { real = o.realpath(o.execPath); } catch { real = o.execPath; }
  const cellar = CELLAR_RE.exec(real);
  if (cellar) {
    const [, prefix, formula] = cellar;
    for (const cand of [`${prefix}/opt/${formula}/bin/node`, `${prefix}/bin/node`]) {
      if (!o.exists(cand)) continue;
      try { if (o.realpath(cand) === real) return { node: cand, ...warn }; } catch { /* broken link */ }
    }
    return { error: T.nodeCellarNoLink(real) };
  }
  if (VERSION_MANAGERS.some((s) => real.includes(s) || o.execPath.includes(s))) return { error: T.nodeVersionManager(real) };
  return { node: o.execPath, ...warn };
}
