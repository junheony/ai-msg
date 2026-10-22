import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
    // Apache-2.0 §4(d): the NOTICE file travels with every copy; the third-party list goes with it.
    expect(pkg.license).toBe('Apache-2.0');
    expect(pkg.files).toEqual(['dist/server', 'dist/ui', 'README.md', 'README.ko.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md']);
    expect(pkg.files).not.toContain('src');
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['web-push', 'ws', 'zod']);
    expect(pkg.devDependencies.esbuild).toBeDefined();
    expect(pkg.devDependencies.react).toBeDefined();
    expect(pkg.engines.node).toBe('>=24');
    expect(pkg.scripts['build:server']).toBe('node scripts/build-server.mjs');
    expect(pkg.scripts.prepack).toBe('npm run build && npm run build:server');
  });

  it('import.meta / __dirname users are the reviewed set (Task 3 table; update both when adding one)', () => {
    expect(filesUsingImportMetaOrDirname()).toEqual([
      'src/server/cli/app.ts',
      'src/server/cli/bin.ts',
      'src/server/config.ts',
      'src/server/engine/claudeCli/childScripts.ts',
      'src/server/engine/claudeCli/fixtures/capture.ts',
      'src/server/engine/claudeCli/fixtures/scrub.ts',
      'src/server/engine/claudeCli/hookRelay.ts',
      'src/server/engine/claudeCli/permissionMcp.ts',
    ]);
  });
});
