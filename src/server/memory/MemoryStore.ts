import fs from 'node:fs/promises';
import { MEMORY_MAX_BYTES, memoryBytes, normalizeMemory } from '../../shared/memory';

export class MemoryTooLarge extends Error {
  constructor() { super(`메모는 ${MEMORY_MAX_BYTES}바이트까지 쓸 수 있습니다`); }
}

/**
 * deck 메모 (`memory.md` in the config dir): one plain-text note, read on every turn from memory (no disk read per turn).
 * Written atomically (temp file + rename) with mode 0600 — it may hold personal context.
 */
export class MemoryStore {
  private text = '';
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly max = MEMORY_MAX_BYTES) {}

  async load(): Promise<void> {
    try {
      const raw = normalizeMemory(await fs.readFile(this.file, 'utf8'));
      // A file edited by hand past the cap is cut at a character boundary rather than refused.
      this.text = memoryBytes(raw) > this.max ? cut(raw, this.max) : raw;
    } catch {
      this.text = '';
    }
  }

  get(): string {
    return this.text;
  }

  async set(text: string): Promise<string> {
    const next = normalizeMemory(text);
    if (memoryBytes(next) > this.max) throw new MemoryTooLarge();
    // Turns see the new note only once it is on disk: a failed save (500) leaves the old one in use.
    const write = this.writing.then(async () => {
      const tmp = `${this.file}.tmp-${process.pid}`;
      await fs.writeFile(tmp, next ? `${next}\n` : '', { mode: 0o600 });
      await fs.rename(tmp, this.file);
      this.text = next;
    });
    this.writing = write.catch(() => {});
    await write;
    return next;
  }
}

function cut(text: string, max: number): string {
  let out = '';
  for (const ch of text) {
    if (memoryBytes(out + ch) > max) break;
    out += ch;
  }
  return out.trim();
}
