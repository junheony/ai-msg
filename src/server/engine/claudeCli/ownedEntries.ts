// src/server/engine/claudeCli/ownedEntries.ts
import type { CliMessage } from './messages';

/**
 * Transcript entries deck's own CLI children wrote, known from their stdout: entry uuids (assistant, user, replayed
 * prompts), API message ids (one assistant message is several transcript entries, one per content block), and
 * the uuids deck put on its stdin prompts. Replaces `entrypoint === 'sdk-ts'`. In memory, bounded, FIFO.
 */
export class OwnedEntries {
  private readonly keys = new Set<string>();
  constructor(private readonly max = 50_000) {}

  get size(): number { return this.keys.size; }

  add(key: string): void {
    if (!key || this.keys.has(key)) return;
    this.keys.add(key);
    if (this.keys.size > this.max) this.keys.delete(this.keys.values().next().value!);
  }

  note(m: CliMessage): void {
    if (m.type === 'assistant') {
      if (typeof m.uuid === 'string') this.add(m.uuid);
      if (typeof m.message.id === 'string') this.add(m.message.id);
    } else if (m.type === 'user' && typeof m.uuid === 'string') {
      this.add(m.uuid);
    }
  }

  has(uuid: string, messageId: string | null): boolean {
    return this.keys.has(uuid) || (messageId !== null && this.keys.has(messageId));
  }
}

/** The server-wide instance: the engine notes every frame, foreign-write checks ask it. */
export const deckWrites = new OwnedEntries();
