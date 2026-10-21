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
