import fs from 'node:fs/promises';
import path from 'node:path';
import { isPermMode, permModeFromAutoApprove, type PermMode } from '../shared/permission';
import type { EngineKind } from '../shared/models';
import { ENGINE_KINDS, ROUTING_POLICIES, type DeckSettings, type RoutingPolicy } from '../shared/protocol';

/**
 * A fresh install asks before every tool call (기본 — 묻기); 모두 자동 승인 is opt-in through the settings screen.
 * An existing `settings.json` always wins over these. 자동 routing spreads load (고르게 분산). 같은 벤더 계정 자동 순환 is
 * off until the user turns it on (and agrees to the own-accounts-only notice); a file without it = off. 자동 분배 may use
 * every engine, but Gemini / Grok only after their external-transfer card (autoConsent, empty by default).
 */
export const DEFAULT_SETTINGS: Required<DeckSettings> = { autoApprove: false, defaultPermissionMode: 'default', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, autoEngines: [...ENGINE_KINDS], autoConsent: [], grokFast: false };

type CommanderSettings = Pick<Required<DeckSettings>, 'commanderEnabled' | 'commanderMaxTurns' | 'commanderTokenCap'>;
type AutoRouteSettings = Pick<Required<DeckSettings>, 'autoEngines' | 'autoConsent' | 'grokFast'>;

/** Both permission fields from one source: `defaultPermissionMode` wins; a lone legacy `autoApprove` maps to bypass / default. */
function normalize(mode: PermMode, routingPolicy: RoutingPolicy, sameVendorRotation: boolean, commander: CommanderSettings, auto: AutoRouteSettings): Required<DeckSettings> {
  return { autoApprove: mode === 'bypassPermissions', defaultPermissionMode: mode, routingPolicy, sameVendorRotation, ...commander, ...auto };
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

/** Server-wide settings (`settings.json`), shared by every device. A missing or corrupt file = defaults. */
export class SettingsStore {
  private current: Required<DeckSettings> = { ...DEFAULT_SETTINGS };
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
    this.current = normalize(mode, isRoutingPolicy(r.routingPolicy) ? r.routingPolicy : DEFAULT_SETTINGS.routingPolicy, r.sameVendorRotation === true, commanderFrom(r), autoRouteFrom(r));
  }

  get(): Required<DeckSettings> {
    return this.current;
  }

  async set(patch: Partial<DeckSettings>): Promise<Required<DeckSettings>> {
    const mode = patch.defaultPermissionMode ?? (patch.autoApprove !== undefined ? permModeFromAutoApprove(patch.autoApprove) : this.current.defaultPermissionMode);
    const next = normalize(mode, patch.routingPolicy ?? this.current.routingPolicy, patch.sameVendorRotation ?? this.current.sameVendorRotation, { commanderEnabled: patch.commanderEnabled ?? this.current.commanderEnabled, commanderMaxTurns: this.current.commanderMaxTurns, commanderTokenCap: this.current.commanderTokenCap }, {
      autoEngines: engineList(patch.autoEngines) ?? this.current.autoEngines,
      autoConsent: engineList(patch.autoConsent) ?? this.current.autoConsent,
      grokFast: patch.grokFast ?? this.current.grokFast,
    });
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
