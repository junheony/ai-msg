import fs from 'node:fs/promises';
import path from 'node:path';
import { isPermMode, permModeFromAutoApprove, type PermMode } from '../shared/permission';
import type { EngineKind } from '../shared/models';
import { ENGINE_KINDS, ROUTING_POLICIES, type DeckSettings, type ExperimentalSettings, type RoutingPolicy } from '../shared/protocol';
import { DEFAULT_TASK_SOFT_CAP, clampTaskCap } from '../shared/tasks';
import { isLocale, type Locale } from '../shared/locale';

/**
 * A fresh install asks before every tool call (기본 — 묻기); 모두 자동 승인 is opt-in through the settings screen.
 * An existing `settings.json` always wins over these. 자동 routing spreads load (고르게 분산). 같은 벤더 계정 자동 순환 is
 * off until the user turns it on (and agrees to the own-accounts-only notice); a file without it = off. 자동 분배 may use
 * every engine, but Gemini / Grok only after their external-transfer card (autoConsent, empty by default).
 * 실험적 기능: Grok Bot and Claude Desktop reads are off on a fresh install; Codex / agy import reads stay on (see experimentalFrom).
 */
export type ServerSettings = Required<Omit<DeckSettings, 'language'>> & {
  /** Absent = from the environment (resolveServerLocale); only an explicit pick is stored. */
  language?: Locale;
};

export const DEFAULT_EXPERIMENTAL: ExperimentalSettings = { grokBot: false, desktop: false, localImports: true };
/** What an install from before the 실험적 기능 switches gets: everything it already did keeps working. */
export const LEGACY_EXPERIMENTAL: ExperimentalSettings = { grokBot: true, desktop: true, localImports: true };

export const DEFAULT_SETTINGS: ServerSettings = { autoApprove: false, defaultPermissionMode: 'default', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, autoEngines: [...ENGINE_KINDS], autoConsent: [], grokFast: false, taskSoftCap: DEFAULT_TASK_SOFT_CAP, experimental: { ...DEFAULT_EXPERIMENTAL } };

type CommanderSettings = Pick<ServerSettings, 'commanderEnabled' | 'commanderMaxTurns' | 'commanderTokenCap'>;
type AutoRouteSettings = Pick<ServerSettings, 'autoEngines' | 'autoConsent' | 'grokFast'> & Partial<Pick<DeckSettings, 'taskSoftCap'>>;

/** Both permission fields from one source: `defaultPermissionMode` wins; a lone legacy `autoApprove` maps to bypass / default. */
function normalize(mode: PermMode, routingPolicy: RoutingPolicy, sameVendorRotation: boolean, commander: CommanderSettings, auto: AutoRouteSettings, language: Locale | null, experimental: ExperimentalSettings): ServerSettings {
  return { autoApprove: mode === 'bypassPermissions', defaultPermissionMode: mode, routingPolicy, sameVendorRotation, ...commander, ...auto, taskSoftCap: clampTaskCap(auto.taskSoftCap), experimental, ...(language ? { language } : {}) };
}

/** Each switch the object has as a boolean, the rest from `base`. */
function experimentalFrom(v: unknown, base: ExperimentalSettings): ExperimentalSettings {
  const r = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const pick = (k: keyof ExperimentalSettings) => (typeof r[k] === 'boolean' ? r[k] : base[k]);
  return { grokBot: pick('grokBot'), desktop: pick('desktop'), localImports: pick('localImports') };
}

/** Known engines only, each once, in ENGINE_KINDS order; anything else (not an array) = null. */
function engineList(v: unknown): EngineKind[] | null {
  if (!Array.isArray(v)) return null;
  return ENGINE_KINDS.filter((e) => v.includes(e));
}

/** 자동 분배 settings from the file: unknown engines are dropped, a missing / malformed list falls back to the default. */
function autoRouteFrom(r: Record<string, unknown>): AutoRouteSettings {
  return {
    autoEngines: engineList(r.autoEngines) ?? [...DEFAULT_SETTINGS.autoEngines],
    autoConsent: engineList(r.autoConsent) ?? [],
    grokFast: r.grokFast === true,
    taskSoftCap: clampTaskCap(r.taskSoftCap),
  };
}

/** 총사령탑 settings from the file (`commanderEnabled` also through set_settings): out-of-range values fall back to the defaults. */
function commanderFrom(r: Record<string, unknown>): CommanderSettings {
  const int = (v: unknown, min: number, max: number, dflt: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : dflt);
  return {
    commanderEnabled: r.commanderEnabled === true,
    commanderMaxTurns: int(r.commanderMaxTurns, 1, 50, DEFAULT_SETTINGS.commanderMaxTurns),
    commanderTokenCap: int(r.commanderTokenCap, 1, 1_000_000_000, DEFAULT_SETTINGS.commanderTokenCap),
  };
}

function isRoutingPolicy(v: unknown): v is RoutingPolicy {
  return (ROUTING_POLICIES as readonly unknown[]).includes(v);
}

/**
 * Server-wide settings (`settings.json`), shared by every device. A missing or corrupt file = defaults.
 *
 * 실험적 기능 migration: a file without `experimental` is decided once, at load, and written back at once (so the answer
 * never changes later). Install from before the switches — the file is a JSON object (an older deck wrote it), or
 * `existingInstall` says so (deck's own session state is there: an install that never opened 설정) — keeps everything on
 * (LEGACY_EXPERIMENTAL), as it ran before; anything else is a fresh install (DEFAULT_EXPERIMENTAL). Deck's own files are
 * the signal: nothing of Grok Bot or Claude Desktop is looked at to decide it.
 */
export class SettingsStore {
  private current: ServerSettings = { ...DEFAULT_SETTINGS };
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly existingInstall: () => Promise<boolean> = async () => false) {}

  async load(): Promise<void> {
    const raw = await fs.readFile(this.file, 'utf8').catch(() => null);
    let parsed: unknown;
    try {
      parsed = raw === null ? null : JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const fromOlderDeck = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    const r = fromOlderDeck ? (parsed as Record<string, unknown>) : {};
    // Migration: a file from before per-session modes has only autoApprove.
    const mode = isPermMode(r.defaultPermissionMode) ? r.defaultPermissionMode : typeof r.autoApprove === 'boolean' ? permModeFromAutoApprove(r.autoApprove) : DEFAULT_SETTINGS.defaultPermissionMode;
    const decided = r.experimental && typeof r.experimental === 'object';
    const legacy = !decided && (fromOlderDeck || (await this.existingInstall().catch(() => false)));
    const experimental = experimentalFrom(r.experimental, legacy ? LEGACY_EXPERIMENTAL : DEFAULT_EXPERIMENTAL);
    this.current = normalize(mode, isRoutingPolicy(r.routingPolicy) ? r.routingPolicy : DEFAULT_SETTINGS.routingPolicy, r.sameVendorRotation === true, commanderFrom(r), autoRouteFrom(r), isLocale(r.language) ? r.language : null, experimental);
    // A corrupt file is left for the user to see (the next change through 설정 replaces it, as before).
    if (!decided && (raw === null || fromOlderDeck)) await this.write(this.current).catch((err: unknown) => console.warn('deck: settings migration not saved', err instanceof Error ? err.message : err));
  }

  get(): ServerSettings {
    return this.current;
  }

  async set(patch: Partial<Omit<DeckSettings, 'experimental'>> & { experimental?: Partial<ExperimentalSettings> }): Promise<ServerSettings> {
    const mode = patch.defaultPermissionMode ?? (patch.autoApprove !== undefined ? permModeFromAutoApprove(patch.autoApprove) : this.current.defaultPermissionMode);
    const next = normalize(mode, patch.routingPolicy ?? this.current.routingPolicy, patch.sameVendorRotation ?? this.current.sameVendorRotation, { commanderEnabled: patch.commanderEnabled ?? this.current.commanderEnabled, commanderMaxTurns: this.current.commanderMaxTurns, commanderTokenCap: this.current.commanderTokenCap }, {
      autoEngines: engineList(patch.autoEngines) ?? this.current.autoEngines,
      autoConsent: engineList(patch.autoConsent) ?? this.current.autoConsent,
      grokFast: patch.grokFast ?? this.current.grokFast,
      taskSoftCap: patch.taskSoftCap ?? this.current.taskSoftCap,
    }, patch.language === undefined ? (this.current.language ?? null) : isLocale(patch.language) ? patch.language : null, experimentalFrom(patch.experimental, this.current.experimental));
    this.current = next;
    await this.write(next);
    return next;
  }

  private async write(next: ServerSettings): Promise<void> {
    this.writing = this.writing.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.file);
    });
    await this.writing;
  }
}
