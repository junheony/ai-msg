import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EntitlementRes } from '../../shared/cloud/api-types';
import { exportStaticPrivate, generateStaticKey } from '../../shared/cloud/noise';

export type TrustedDevice = { id: string; name: string; pub: string /* X25519 32B b64u */; addedAt: number };
export type CloudStateData = {
  v: 2;
  hostId: string | null;
  hostToken: string | null;
  email: string | null;
  hostKey: string /* pkcs8 b64u */;
  devices: TrustedDevice[];
  pendingRevokes: string[];
  plan: EntitlementRes | null;
};

const blank = (hostKey: string): CloudStateData => ({ v: 2, hostId: null, hostToken: null, email: null, hostKey, devices: [], pendingRevokes: [], plan: null });

function valid(d: unknown): d is CloudStateData {
  const o = d as Partial<CloudStateData> | null;
  return !!o && typeof o === 'object' && o.v === 2 && typeof o.hostKey === 'string' && o.hostKey.length > 0
    && Array.isArray(o.devices) && Array.isArray(o.pendingRevokes);
}

/**
 * The Mac's cloud link: `<configDir>/cloud/state.json` (0600, folder 0700, temp file → rename). Loading never writes,
 * so the folder appears only with the first `update` (after listen — Global Constraints). A broken file, or one of
 * another version, is moved to `state.json.broken-<ms>` and the state starts over.
 */
export class CloudState {
  private writing: Promise<void> = Promise.resolve();

  private constructor(private readonly file: string, private data: CloudStateData) {}

  static async load(configDir: string): Promise<CloudState> {
    const file = path.join(configDir, 'cloud', 'state.json');
    let text: string | null = null;
    try { text = await fs.readFile(file, 'utf8'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (text !== null) {
      let parsed: unknown = null;
      try { parsed = JSON.parse(text); } catch { /* broken */ }
      if (valid(parsed)) return new CloudState(file, { ...blank(parsed.hostKey), ...parsed });
      await fs.rename(file, `${file}.broken-${Date.now()}`);
    }
    return new CloudState(file, blank(await exportStaticPrivate(await generateStaticKey({ extractable: true }))));
  }

  get(): CloudStateData {
    return this.data;
  }

  async update(p: Partial<CloudStateData>): Promise<void> {
    this.data = { ...this.data, ...p, v: 2 };
    await this.write();
  }

  async removeDevice(id: string): Promise<boolean> {
    if (!this.data.devices.some((d) => d.id === id)) return false;
    await this.update({ devices: this.data.devices.filter((d) => d.id !== id) });
    return true;
  }

  /** Forgets the link (host id, token, email, devices, plan); the host key stays. */
  async reset(): Promise<void> {
    this.data = blank(this.data.hostKey);
    await this.write();
  }

  private async write(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writing = this.writing.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(tmp, snapshot, { mode: 0o600 });
        await fs.rename(tmp, this.file);
      } catch (e) {
        await fs.rm(tmp, { force: true });
        throw e;
      }
    });
    await this.writing;
  }
}
