// Whether the first-run wizard still has to be shown: `<configDir>/setup.json` (plan ② Task 5).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

type SetupFile = { state: 'pending'; createdAt: string } | { state: 'done'; doneAt: string; migrated?: true };

/** Files only a used deck has (never the token: a fresh server writes it before anyone looked at the wizard). */
const INSTALL_FILES = ['session-meta.json', 'session-state.json', 'activity.json', 'pins.json', 'projects.json', 'push-subscriptions.json', 'accounts.json'];

/**
 * An install that was in use before setup.json existed: one of its data files is there and not empty. `startServer`
 * asks once, right after the lock and listen, before any store has written its file.
 */
export function existingInstall(configDir: string): boolean {
  return INSTALL_FILES.some((name) => {
    try {
      const st = fs.statSync(path.join(configDir, name));
      return st.isFile() && st.size > 0;
    } catch {
      return false;
    }
  });
}

async function writeAtomic(file: string, data: SetupFile): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await fsp.rename(tmp, file);
}

export class SetupStore {
  private constructor(private readonly file: string, private state: SetupFile['state']) {}

  /**
   * No file: an existing install is recorded as done (migrated) and never sees the wizard; a fresh one writes pending at
   * once, so a restart before the wizard shows it again. A broken file reads as pending and stays until `markDone`.
   */
  static async open(file: string, o: { existingInstall: boolean }): Promise<SetupStore> {
    let text: string | null = null;
    try { text = await fsp.readFile(file, 'utf8'); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return new SetupStore(file, 'pending');
    }
    if (text === null) {
      const now = new Date().toISOString();
      const data: SetupFile = o.existingInstall ? { state: 'done', doneAt: now, migrated: true } : { state: 'pending', createdAt: now };
      await writeAtomic(file, data);
      return new SetupStore(file, data.state);
    }
    try {
      const state = (JSON.parse(text) as { state?: unknown }).state;
      return new SetupStore(file, state === 'done' ? 'done' : 'pending');
    } catch {
      return new SetupStore(file, 'pending');
    }
  }

  needed(): boolean {
    return this.state === 'pending';
  }

  async markDone(): Promise<void> {
    await writeAtomic(this.file, { state: 'done', doneAt: new Date().toISOString() });
    this.state = 'done';
  }
}
