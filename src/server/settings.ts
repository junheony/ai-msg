import fs from 'node:fs/promises';
import path from 'node:path';
import { isPermMode, permModeFromAutoApprove, type PermMode } from '../shared/permission';
import type { DeckSettings } from '../shared/protocol';

/** 자동 승인 (new sessions in 모두 자동 승인) unless the user turned it off. */
export const DEFAULT_SETTINGS: DeckSettings = { autoApprove: true, defaultPermissionMode: 'bypassPermissions' };

/** Both fields from one source: `defaultPermissionMode` wins; a lone legacy `autoApprove` maps to bypass / default. */
function normalize(mode: PermMode): DeckSettings {
  return { autoApprove: mode === 'bypassPermissions', defaultPermissionMode: mode };
}

/** Server-wide settings (`settings.json`), shared by every device. A missing or corrupt file = defaults. */
export class SettingsStore {
  private current: DeckSettings = { ...DEFAULT_SETTINGS };
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      parsed = null;
    }
    const r = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    // Migration: a file from before per-session modes has only autoApprove.
    const mode = isPermMode(r.defaultPermissionMode) ? r.defaultPermissionMode : typeof r.autoApprove === 'boolean' ? permModeFromAutoApprove(r.autoApprove) : DEFAULT_SETTINGS.defaultPermissionMode;
    this.current = normalize(mode);
  }

  get(): DeckSettings {
    return this.current;
  }

  async set(patch: Partial<DeckSettings>): Promise<DeckSettings> {
    const mode = patch.defaultPermissionMode ?? (patch.autoApprove !== undefined ? permModeFromAutoApprove(patch.autoApprove) : this.current.defaultPermissionMode);
    const next = normalize(mode);
    this.current = next;
    this.writing = this.writing.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.file);
    });
    await this.writing;
    return next;
  }
}
