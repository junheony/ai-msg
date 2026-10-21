#!/usr/bin/env node
// Bundles the server for the npm package: dist/server/{bin,app,hookRelay,permissionMcp}.js.
// Usage: node scripts/build-server.mjs [--outdir <dir>]   (default dist/server)
// Fails when ① a Claude child script got inlined into app.js, ② bin.js pulled in anything beyond bin.ts,
// ③ an output imports a package that is not a runtime dependency, ④ a child script imports anything but node: built-ins.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const i = argv.indexOf('--outdir');
if (i >= 0 && !argv[i + 1]) {
  console.error('build-server: --outdir 에 경로가 필요합니다');
  process.exit(2);
}
const outdir = path.resolve(i >= 0 ? argv[i + 1] : path.join(root, 'dist', 'server'));

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const deps = Object.keys(pkg.dependencies ?? {});

const ENTRIES = {
  bin: 'src/server/cli/bin.ts',
  app: 'src/server/cli/app.ts',
  hookRelay: 'src/server/engine/claudeCli/hookRelay.ts',
  permissionMcp: 'src/server/engine/claudeCli/permissionMcp.ts',
};
const CHILDREN = ['hookRelay', 'permissionMcp'];

fs.mkdirSync(outdir, { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: Object.fromEntries(Object.entries(ENTRIES).map(([k, v]) => [k, path.join(root, v)])),
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  splitting: false,
  metafile: true,
  sourcemap: false,
  logLevel: 'warning',
});

const errors = [];
const isDep = (p) => deps.some((d) => p === d || p.startsWith(d + '/'));
const rel = (f) => path.relative(root, path.resolve(root, f)).split(path.sep).join('/');
for (const [file, out] of Object.entries(result.metafile.outputs)) {
  const name = path.basename(file, '.js');
  if (!(name in ENTRIES)) {
    errors.push(`예상하지 않은 산출물: ${file}`);
    continue;
  }
  const inputs = Object.keys(out.inputs).map(rel);
  if (name === 'app') {
    for (const c of CHILDREN) if (inputs.includes(ENTRIES[c])) errors.push(`① app.js 에 자식 스크립트 ${ENTRIES[c]} 가 섞였습니다`);
  }
  if (name === 'bin') {
    const extra = inputs.filter((f) => f !== ENTRIES.bin);
    if (extra.length) errors.push(`② bin.js 에 bin.ts 외 입력이 있습니다: ${extra.join(', ')}`);
  }
  for (const imp of out.imports) {
    if (!imp.external) continue;
    const p = imp.path;
    if (p.startsWith('node:')) continue;
    if (name === 'bin' && p === './app.js') continue;
    if (CHILDREN.includes(name)) errors.push(`④ ${name}.js 가 node: 외 모듈을 불러옵니다: ${p}`);
    else if (!isDep(p)) errors.push(`③ ${name}.js 가 dependencies 에 없는 모듈을 불러옵니다: ${p}`);
  }
}

if (errors.length) {
  for (const e of errors) console.error(`build-server: ${e}`);
  process.exit(1);
}

const bin = path.join(outdir, 'bin.js');
const src = fs.readFileSync(bin, 'utf8');
if (!src.startsWith('#!/usr/bin/env node\n')) fs.writeFileSync(bin, '#!/usr/bin/env node\n' + src);
fs.chmodSync(bin, 0o755);
console.log(`build-server: ${outdir}`);
