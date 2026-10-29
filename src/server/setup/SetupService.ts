// The setup wizard's view (GET /api/setup): CLI probes (cached 30 s, one run at a time) plus the Claude profile list
// read fresh from accounts.json, and the profile add (plan ② Task 5, D4: applied at the next start).
import fs from 'node:fs';
import path from 'node:path';
import type { AccountRegistry } from '../../shared/accounts';
import type { ClaudeProfileProbe, EngineProbe, GeminiSeatProbe, SetupStatus } from '../../shared/setup-types';
import { AccountsFileError, loadAccountRegistry } from '../accounts';
import type { DeckConfig } from '../config';
import { probeEngines, type ProbeExec, type ProbeProfile } from './detect';
import { addClaudeProfile } from './profiles';
import type { SetupStore } from './SetupStore';

const DEFAULT_TTL_MS = 30_000;

type Probe = { engines: EngineProbe[]; claudeProfiles: ClaudeProfileProbe[]; geminiSeats: GeminiSeatProbe[]; checkedAt: string };

export class SetupService {
  private cache: { at: number; value: Promise<Probe> } | null = null;
  /** The probe still running, shared by every caller (a forced refresh too) so repeated clicks never pile up CLIs. */
  private inflight: Promise<Probe> | null = null;
  private readonly now: () => number;

  constructor(private readonly o: {
    cfg: Pick<DeckConfig, 'claudeBin' | 'codexBin' | 'geminiBin' | 'grokBin' | 'grokHome' | 'home' | 'configDir'>;
    /** The registry the running server started with. */
    accounts: AccountRegistry;
    store: SetupStore;
    supervised: () => Promise<boolean>;
    addresses: string[];
    exec?: ProbeExec;
    env?: NodeJS.ProcessEnv;
    ttlMs?: number;
    now?: () => number;
  }) {
    this.now = o.now ?? Date.now;
  }

  private accountsFile(): string {
    return path.join(this.o.cfg.configDir, 'accounts.json');
  }

  /** The accounts as the next start will see them: accounts.json when there is a usable one, else the running registry. */
  private fileRegistry(): { reg: AccountRegistry; file: boolean } {
    if (!fs.existsSync(this.accountsFile())) return { reg: this.o.accounts, file: false };
    try {
      return { reg: loadAccountRegistry({ configDir: this.o.cfg.configDir, homeDir: this.o.cfg.home, log: () => {} }), file: true };
    } catch (err) {
      if (err instanceof AccountsFileError) return { reg: this.o.accounts, file: true };
      throw err;
    }
  }

  private probe(): Promise<Probe> {
    const env = this.o.env ?? process.env;
    const { reg } = this.fileRegistry();
    const running = this.o.accounts;
    const profiles: ProbeProfile[] = reg.all().map((id) => ({
      id: String(id), label: reg.label(id), dir: reg.profileDir(id), home: running.has(id) && running.isHome(id),
      active: running.has(id) && !running.isRetired(id) && !reg.isRetired(id), env: reg.env(id, env),
    }));
    return probeEngines({ cfg: this.o.cfg, profiles, env, ...(this.o.exec ? { exec: this.o.exec } : {}) })
      .then((r) => ({ ...r, checkedAt: new Date(this.now()).toISOString() }));
  }

  async status(force = false): Promise<SetupStatus> {
    const t = this.now();
    let value = this.inflight ?? this.cache?.value;
    if (!this.inflight && (force || !this.cache || t - this.cache.at >= (this.o.ttlMs ?? DEFAULT_TTL_MS))) {
      const started = this.probe();
      value = started;
      this.inflight = started;
      this.cache = { at: t, value: started };
      started.then(() => { if (this.inflight === started) this.inflight = null; }, () => {
        if (this.inflight === started) this.inflight = null;
        if (this.cache?.value === started) this.cache = null;
      });
    }
    const [probe, supervised] = await Promise.all([value as Promise<Probe>, this.o.supervised().catch(() => false)]);
    const { reg, file } = this.fileRegistry();
    const fileIds = new Set(reg.all());
    const runIds = new Set(this.o.accounts.all());
    const restartNeeded = file && (fileIds.size !== runIds.size || [...fileIds].some((id) => !runIds.has(id)));
    return { engines: probe.engines, claudeProfiles: probe.claudeProfiles, geminiSeats: probe.geminiSeats, addresses: this.o.addresses, needed: this.o.store.needed(), supervised, restartNeeded, accountsFile: file, checkedAt: probe.checkedAt };
  }

  async addProfile(id: string, label?: string): Promise<{ profile: ClaudeProfileProbe; restartNeeded: true }> {
    await addClaudeProfile({ configDir: this.o.cfg.configDir, home: this.o.cfg.home, id, ...(label !== undefined ? { label } : {}) });
    // A probe started before the add does not know the new profile: let it finish, then probe afresh.
    await this.inflight?.catch(() => {});
    const st = await this.status(true);
    const profile = st.claudeProfiles.find((p) => p.id === id);
    if (!profile) throw new Error(`added profile ${id} is not in accounts.json`);
    return { profile, restartNeeded: true };
  }

  markDone(): Promise<void> {
    return this.o.store.markDone();
  }
}
