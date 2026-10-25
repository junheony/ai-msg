import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EntitlementRes } from '../../shared/cloud/api-types';
import { exportStaticPrivate, generateStaticKey, importStaticPrivate } from '../../shared/cloud/noise';

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

const strOrNull = (v: unknown) => v === null || v === undefined || typeof v === 'string';

/** The shape, the token fields' types, and a host key that really imports as an X25519 pkcs8 key. */
async function valid(d: unknown): Promise<boolean> {
  const o = d as Partial<CloudStateData> | null;
  if (!o || typeof o !== 'object' || o.v !== 2 || typeof o.hostKey !== 'string' || o.hostKey.length === 0) return false;
  if (!Array.isArray(o.devices) || !Array.isArray(o.pendingRevokes)) return false;
  if (!strOrNull(o.hostId) || !strOrNull(o.hostToken) || !strOrNull(o.email)) return false;
  try { await importStaticPrivate(o.hostKey); } catch { return false; }
  return true;
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
      if (await valid(parsed)) {
        const p = parsed as CloudStateData;
        return new CloudState(file, { ...blank(p.hostKey), ...p });
      }
      await fs.rename(file, `${file}.broken-${Date.now()}`);
    }
    return new CloudState(file, blank(await exportStaticPrivate(await generateStaticKey({ extractable: true }))));
  }

  get(): CloudStateData {
    return this.data;
  }

  /** Merges `p`; the host key and version are never replaced this way. */
  async update(p: Partial<Omit<CloudStateData, 'v' | 'hostKey'>>): Promise<void> {
    this.data = { ...this.data, ...p, v: 2, hostKey: this.data.hostKey };
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
      const dir = path.dirname(this.file);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.chmod(dir, 0o700); // before the temp file lands, also when the folder already existed with wider rights
      const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const fh = await fs.open(tmp, 'w', 0o600);
        try {
          await fh.writeFile(snapshot);
          await fh.sync();
        } finally {
          await fh.close();
        }
        await fs.rename(tmp, this.file);
      } catch (e) {
        await fs.rm(tmp, { force: true });
        throw e;
      }
    });
    await this.writing;
  }
}
