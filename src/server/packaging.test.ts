import { describe, expect, it } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { HERMES_BOOTSTRAP } from './engine/HermesEngine';

const root = path.resolve(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, any>;

/** Files under src/server, src/shared (tests excluded) that use import.meta.url/dirname/filename or __dirname/__filename. */
function filesUsingImportMetaOrDirname(): string[] {
  const out = execFileSync('grep', ['-rlE', 'import\\.meta\\.(url|dirname|filename)|__dirname|__filename', 'src/server', 'src/shared'], { cwd: root, encoding: 'utf8' });
  return out.split('\n').filter((f) => f && !/\.test\.tsx?$/.test(f)).sort();
}

describe('package metadata', () => {
  it('ships the bundled server, not the sources', () => {
    // D1 (npm name) is open: publishing stays blocked by `private` until Task 8 sets the name.
    expect(pkg.private).toBe(true);
    expect(pkg.bin).toEqual({ 'ai-msg': 'dist/server/bin.js' });
    expect(pkg.files).toEqual(['dist/server', 'dist/ui', 'README.md', 'README.ko.md', 'LICENSE', 'SECURITY.md']);
    expect(pkg.files).not.toContain('src');
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['web-push', 'ws', 'zod']);
    expect(pkg.devDependencies.esbuild).toBeDefined();
    expect(pkg.devDependencies.react).toBeDefined();
    expect(pkg.engines.node).toBe('>=24');
    expect(pkg.scripts['build:server']).toBe('node scripts/build-server.mjs');
    expect(pkg.scripts.prepack).toBe('npm run build && npm run build:server');
  });

  it('ships the Hermes Python bootstrap beside the bundle and resolves it from the source tree', async () => {
    expect(HERMES_BOOTSTRAP).toBe(path.join(root, 'src/server/engine/hermesAcpBootstrap.py'));
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-package-'));
    try {
      await promisify(execFile)(process.execPath, [path.join(root, 'scripts/build-server.mjs'), '--outdir', outdir], { cwd: root, timeout: 20_000 });
      expect(fs.readFileSync(path.join(outdir, 'hermesAcpBootstrap.py'), 'utf8')).toBe(fs.readFileSync(HERMES_BOOTSTRAP, 'utf8'));
      expect(fs.readFileSync(path.join(outdir, 'app.js'), 'utf8')).toMatch(/new URL\(["']\.\/hermesAcpBootstrap\.py["'], import\.meta\.url\)/);
    } finally { fs.rmSync(outdir, { recursive: true, force: true }); }
  }, 25_000);

  it('import.meta / __dirname users are the reviewed set (docs/packaging.md table; update both when adding one)', () => {
    expect(filesUsingImportMetaOrDirname()).toEqual([
      'src/server/cli/app.ts',
      'src/server/cli/bin.ts',
      'src/server/config.ts',
      'src/server/engine/HermesEngine.ts',
      'src/server/engine/claudeCli/childScripts.ts',
      'src/server/engine/claudeCli/fixtures/capture.ts',
      'src/server/engine/claudeCli/fixtures/scrub.ts',
      'src/server/engine/claudeCli/hookRelay.ts',
      'src/server/engine/claudeCli/permissionMcp.ts',
    ]);
  });
});
