// Fail the build when a JS chunk exceeds Vite's 500 kB warning (minified size, KiB).
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('dist/ui/assets');
const limitKib = 500;
const big = [];
for (const name of fs.readdirSync(dir)) {
  if (!name.endsWith('.js')) continue;
  const kib = fs.statSync(path.join(dir, name)).size / 1024;
  if (kib > limitKib) big.push(`${name} ${kib.toFixed(1)} kB`);
}
if (big.length) {
  console.error(`JS chunks over ${limitKib} kB:\n${big.join('\n')}`);
  process.exit(1);
}
