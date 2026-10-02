import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Identifies the served UI build (hash of dist/ui/index.html, which names the hashed assets); null when there is no build (dev). */
export function computeBuildId(uiDir: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(uiDir, 'index.html'))).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}
