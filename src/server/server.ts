import { liveBuildId } from './buildId';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AttachmentStore } from './attachments/AttachmentStore';
import { loadOrCreateToken } from './auth';
import { bindAddresses, tailscaleDnsName, tailscaleIPv4s } from './bind';
import { loadConfig, repoRootDefault, type DeckConfig } from './config';
import { acquireInstanceLock, commandOfPid } from './instanceLock';
import { ChildRegistry, groupAlive, killGroup, processStartMs } from './childRegistry';
import { texts } from './setup/texts';
import { setLocale } from '../shared/locale';
import { resolveServerLocale } from './i18n';
import { SetupService } from './setup/SetupService';
import { SetupStore, existingInstall } from './setup/SetupStore';
import { ClaudeEngine } from './engine/ClaudeEngine';
import { childScript, snapshotChildScripts } from './engine/claudeCli/childScripts';
import { MIN_CLAUDE_VERSION, RECOMMENDED_CLAUDE_VERSION, type ClaudeBin } from './engine/claudeCli/version';
import { CodexEngine } from './engine/CodexEngine';
import { SlashCommandCache } from './engine/slashCommands';
import { FileLister } from './files';
import { GeminiEngine, GeminiLogin } from './engine/GeminiEngine';
import { grokEngineLock, runGrokTurn } from './engine/GrokEngine';
import { runGrokInspect } from './engine/grokInspect';
import { probeGrokBilling } from './engine/grokBilling';
import { grokLock } from './engine/grokLock';
import { sweepShadowHomes } from './engine/shadowHome';
import { grokEnv } from './engine/grokEnv';
import { execFile } from 'node:child_process';
import { createRequestHandler, type ServerUpdateDeps } from './http';
import { ServerUpdateWatch, startSupervisor, supervisionCheck } from './serverUpdate';
import { flushThenExit, installGracefulShutdown } from './lifecycle';
import { EventLog } from './highlights';
import { BottleneckWatch, type RetryRequest } from './push/BottleneckWatch';
import { PushNotifier } from './push/PushNotifier';
import { TaskRegistry } from './tasks/TaskRegistry';
import { readAllCooldownsMs } from './routing/cooldown';
import { SubscriptionStore } from './push/SubscriptionStore';
import { loadOrCreateVapid } from './push/vapid';
import { PinStore } from './sessions/PinStore';
import { MemoryStore } from './memory/MemoryStore';
import { pruneRootsOf, startBackupPruning } from './sessions/backupPrune';
import { SessionMetaStore } from './sessions/SessionMetaStore';
import { AcceptedRefs } from './sessions/AcceptedRefs';
import { TranscriptSearch } from './sessions/search';
import { pruneTranscriptSnapshots, setTranscriptCacheDir } from './sessions/transcript';
import { SettingsStore } from './settings';
import { ProcessHolders } from './sessions/ProcessHolders';
import { SessionIndex } from './sessions/SessionIndex';
import { GeminiConversationIndex } from './sessions/GeminiImports';
import { GrokBotIndex } from './sessions/GrokBotImports';
import { gated } from './sessions/ImportIndex';
import { GrokSessionIndex } from './sessions/GrokImports';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner } from './turn/TurnRunner';
import { ClaudeUsagePoller, claudePollBin } from './usage/ClaudeUsagePoller';
import { CodexUsagePoller } from './usage/CodexUsagePoller';
import { GeminiUsagePoller } from './usage/GeminiUsagePoller';
import { GrokUsageTracker } from './usage/GrokUsageTracker';
import { GrokBillingPoller } from './usage/GrokBillingPoller';
import { UsageIndex } from './usage/UsageIndex';
import { UsageService } from './usage/UsageService';
import { attachWebSocket, type ServerSend } from './ws';
import { recordAudit } from './audit';
import { Commander } from './commander/Commander';
import { judge } from './commander/Judge';
import { isOtherEngineState } from './turn/SessionState';
import { GEMINI_ACCOUNTS, type GeminiAccount } from '../shared/accounts';
import type { PermMode } from '../shared/permission';
import type { GrokStatus, ServerMessage } from '../shared/protocol';

export class PortInUseError extends Error {
  override name = 'PortInUseError';
  constructor(readonly port: number) { super(`port ${port} is in use`); }
}

/**
 * Listen on every address; if any fails, close the ones already bound (waiting for close) and throw the original error
 * (`EADDRINUSE` → `PortInUseError`) — a partial start never stays half-open.
 */
export async function listenAll(servers: http.Server[], port: number, addresses: string[]): Promise<void> {
  const results = await Promise.allSettled(servers.map((server, i) => new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, addresses[i], () => { server.off('error', onError); resolve(); });
  })));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (!failed) return;
  await Promise.all(servers.filter((s) => s.listening).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  if ((failed.reason as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE') throw new PortInUseError(port);
  throw failed.reason;
}

/** The package.json version next to this code (repo root, or the installed package root for the bundle). */
export function packageVersion(): string {
  try { return String((JSON.parse(readFileSync(path.join(repoRootDefault(), 'package.json'), 'utf8')) as { version?: unknown }).version ?? '0.0.0'); } catch { return '0.0.0'; }
}

export type ListenInfo = { port: number; addresses: string[]; tokenFile: string; tokenCreated: boolean; lockFile: string };

/**
 * Start the server. Order (packaging plan Task 2): config (no writes) → config-dir lock → listen on every address (requests
 * get 503 until ready) → only then anything else is written to the config dir. A failure at any step closes what was
 * opened and releases the lock before the error is thrown.
 */
export async function startServer(o: { cfg?: DeckConfig; onListening?: (info: ListenInfo) => void } = {}): Promise<void> {
  // When this process started: code edited later is what a restart would bring in.
  const startedAt = Date.now() - Math.round(process.uptime() * 1000);
  const cfg = o.cfg ?? loadConfig();
  const addresses = bindAddresses(os.networkInterfaces(), { loopbackOnly: cfg.loopbackOnly, tailscaleIps: tailscaleIPv4s() });
  // DECK_SUPERVISED / DECK_SUPERVISOR can be inherited by anything the server's tree starts: the manager's own markers and
  // the real parent must agree too (relaunch loop, systemd unit, our launchd label).
  const supervisor = startSupervisor({ supervisor: cfg.supervisor, env: process.env, commandOf: commandOfPid });
  const lock = await acquireInstanceLock(cfg.configDir, { pid: process.pid, port: cfg.port, version: packageVersion(), supervisor });
  // Placeholder until everything below is ready; swapped for the real handler at the end.
  let handler: http.RequestListener = (_req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '2', 'cache-control': 'no-store' });
    res.end(texts().starting);
  };
  const bound = addresses.map((address) => ({ address, server: http.createServer((req, res) => handler(req, res)) }));
  const servers = bound.map((b) => b.server);
  try {
    await listenAll(servers, cfg.port, addresses);
  } catch (err) {
    lock.release();
    throw err;
  }
  const port = cfg.port || (servers[0]?.address() as AddressInfo | null)?.port || cfg.port;
  const cleanup: Array<() => void> = [];
  try {
    await lock.update({ addresses, port });
    // S5: detached children (grok) are recorded; after a crash (stale lock taken over) the previous server's are reaped.
    const runDir = path.join(cfg.configDir, 'run');
    const children = ChildRegistry.open(path.join(runDir, 'children.json'));
    if (lock.tookOverStale) await children.reapStale({ isAlive: groupAlive, commandOf: commandOfPid, kill: killGroup, startedAtOf: processStartMs, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    else children.clear();
    // S7: a bundled run's Claude child scripts run from a copy, so an upgrade in place does not swap them under a live child.
    let claudeScripts: ReturnType<typeof snapshotChildScripts> | undefined;
    try { claudeScripts = snapshotChildScripts({ src: path.dirname(childScript('hookRelay')), runDir, version: packageVersion() }); } catch (err) {
      console.error('deck: 자식 스크립트 사본을 만들지 못해 원본을 씁니다', err instanceof Error ? err.message : err);
    }
    // Before any store writes its file: was this config dir in use already (no wizard for it)?
    const setupStore = await SetupStore.open(path.join(cfg.configDir, 'setup.json'), { existingInstall: existingInstall(cfg.configDir) });
    const transcriptCacheDir = path.join(cfg.configDir, 'transcript-cache');
    setTranscriptCacheDir(transcriptCacheDir);
    const pruneTranscriptCache = () => {
      pruneTranscriptSnapshots(transcriptCacheDir).then(
        (removed) => { if (removed.length) console.log(`deck: transcript 캐시 스냅샷 ${removed.length}개 정리`); },
        (err: unknown) => console.error('deck: transcript cache cleanup failed', err instanceof Error ? err.message : err),
      );
    };
    pruneTranscriptCache();
    const transcriptPruneTimer = setInterval(pruneTranscriptCache, 6 * 60 * 60 * 1000);
    transcriptPruneTimer.unref?.();
    cleanup.push(() => clearInterval(transcriptPruneTimer));
    const tokenCreated = !(await fs.readFile(cfg.tokenFile, 'utf8').then((t) => /^[0-9a-f]{64}$/.test(t.trim()), () => false));
    const token = await loadOrCreateToken(cfg.tokenFile);
    const accounts = cfg.accounts;
    const usage = new UsageService({ mode: cfg.usageMode, observedFile: cfg.claudeUsageFile, deckUrl: cfg.deckUrl, accounts, usageSourceFile: cfg.usageSourceFile, strict: cfg.usageStrict, deckConfigured: cfg.deckUrlConfigured, log: (line) => console.error(line) });
    // Session rename / 보관 live in deck's own config (never in the Claude jsonl); loaded before the first scan.
    const meta = new SessionMetaStore(path.join(cfg.configDir, 'session-meta.json'));
    await meta.load();
    // Sessions another `claude` process (Claude Desktop, a terminal) holds open: read-only `ps`, never deck's own CLI children.
    const holders = new ProcessHolders();
    // Conversations made outside deck (imports design): Grok CLI / agy only when deck can continue them; Grok Bot read-only (macOS).
    await fs.rm(cfg.importTmpDir, { recursive: true, force: true }).catch(() => undefined);
    const grokImports = cfg.grokBin ? new GrokSessionIndex(cfg.grokHome) : null;
    // 실험적 기능 (settings `experimental`), asked on every use: off = those apps' files are never read (or written).
    const settings = new SettingsStore(cfg.settingsFile, () => fs.stat(cfg.stateFile).then(() => true, () => false));
    await settings.load();
    // Server messages: the last explicit pick from a device, else the environment (LANG …).
    setLocale(resolveServerLocale(settings.get(), process.env));
    const experimental = () => settings.get().experimental;
    const geminiImports = cfg.geminiBin ? gated(new GeminiConversationIndex([{ account: 'g1', dir: cfg.geminiStateDir }], cfg.importTmpDir), () => experimental().localImports) : null;
    const grokBotImports = new GrokBotIndex(cfg.grokBotDir, cfg.home, undefined, () => experimental().grokBot);
    grokBotImports.onUsage = (u) => usage.applyGrokBot(u);
    const index = new SessionIndex({ grokImports, geminiImports, grokBotImports, holders, roots: cfg.projectsRoots, pinnedFile: cfg.pinnedFile, recentFile: cfg.recentFoldersFile, desktopRoot: cfg.desktopSessionsRoot, codexRoot: cfg.codexSessionsRoot, codexArchivedRoot: cfg.codexArchivedRoot, meta, home: accounts.home, desktopEnabled: () => experimental().desktop, localImportsEnabled: () => experimental().localImports });
    const store = new SessionStateStore(cfg.stateFile);
    const pins = new PinStore(cfg.pinsFile);
    const memory = new MemoryStore(path.join(cfg.configDir, 'memory.md'));
    const tasks = new TaskRegistry(path.join(cfg.configDir, 'tasks.json'));
    const pushSubs = new SubscriptionStore(cfg.pushSubscriptionsFile);
    // Codex rollouts (~1000 files) are read after listening; the sidebar is told when they are in.
    await Promise.all([holders.refresh().then(() => index.refresh({ codexInBackground: true })), store.load(), pins.load(), pushSubs.load(), tasks.load(), memory.load()]);
    const commands = new SlashCommandCache();
    const search = new TranscriptSearch({ sessions: () => index.projects(store.codexEntries(), { all: true }).flatMap((p) => p.sessions) });
    // /api/file never previews deck's own config (token, VAPID key, push subscriptions), even with the cwd at ~.
    const files = new FileLister({ home: cfg.home, roots: cfg.cwdRoots, denyRoots: [await fs.realpath(cfg.configDir).catch(() => cfg.configDir)] });
    usage.start();
    cleanup.push(() => usage.stop());
    // F3: GPT usage from the newest Codex rollouts (Desktop/CLI too), at start and every 60 s.
    const codexUsage = new CodexUsagePoller({ sessionsRoot: cfg.codexSessionsRoot, usage });
    codexUsage.start();
    cleanup.push(() => codexUsage.stop());
    // An account not observed (`cli` mode; usage-deck mode: only one whose dashboard card is not ok) for ~8 min (before it would turn stale) gets its real limits from `claude -p /usage` (no tokens), one at a time, checked every 5 min.
    const pollBin = claudePollBin(cfg);
    const claudeUsage = pollBin ? new ClaudeUsagePoller({ bin: pollBin, accounts, usage }) : null;
    claudeUsage?.start();
    cleanup.push(() => claudeUsage?.stop());
    // 사용량 view: incremental token usage index over every transcript/rollout; first scan runs in the background.
    const usageHistory = new UsageIndex({ projectsRoots: cfg.projectsRoots, codexSessionsRoot: cfg.codexSessionsRoot, indexFile: cfg.usageIndexFile, legacyIndexFile: cfg.usageIndexV1File });
    usageHistory.start();
    cleanup.push(() => usageHistory.stop());
    const attachments = new AttachmentStore(cfg.attachmentsDir);
    await attachments.init();
    attachments.startPurgeTimer();
    cleanup.push(() => attachments.stop());
    // Fork backups (SessionFork) and the 삭제 trash (SessionTrash) live in each profile's config dir; only deck-named, expired entries go.
    const stopBackupPruning = startBackupPruning(accounts.all().flatMap((a) => pruneRootsOf(accounts.profileDir(a))), cfg.backupRetentionDays);
    cleanup.push(stopBackupPruning);
    // D11: Codex is optional; without the binary the UI hides the GPT option and 'auto' means Claude.
    const codex = cfg.codexBin ? new CodexEngine(cfg.codexBin) : null;
    // Gemini (agy): explicit engine only; logged in = an `agy models` probe exited 0 (cached 5 min, checked in the background).
    const geminiLogin = cfg.geminiBin ? new GeminiLogin(cfg.geminiBin) : null;
    void geminiLogin?.refresh();
    const gemini = cfg.geminiBin && geminiLogin ? { engine: new GeminiEngine(cfg.geminiBin), loggedIn: (a: GeminiAccount) => geminiLogin.get(a) } : null;
    // Gemini quota for the usage card: `agy -p=/usage` at start, every 5 min, and after each Gemini turn — only while logged in.
    const geminiUsage = cfg.geminiBin && geminiLogin ? new GeminiUsagePoller({ bin: cfg.geminiBin, usage, login: geminiLogin }) : null;
    geminiUsage?.start();
    cleanup.push(() => geminiUsage?.stop());
    const geminiStatus = () => {
      geminiLogin?.ensureFresh();
      return { available: gemini !== null, loggedIn: Object.fromEntries(GEMINI_ACCOUNTS.map((a) => [a, geminiLogin?.get(a) ?? false])) as Record<GeminiAccount, boolean> };
    };
    // Grok (Grok Build CLI over ACP): explicit engine only. Login is not checked up front (design §5): a logged-out turn ends
    // with "Grok 로그인 필요". x1's GROK_HOME is the real path of ~/.grok, never the shell's GROK_HOME.
    const grokBin = cfg.grokBin;
    // Each turn gets a fresh shadow HOME under here (§14.9-1); folders a crashed server left behind go at start — awaited,
    // so the sweep is over before any Grok turn can make its folder.
    const grokHomesDir = path.join(cfg.configDir, 'homes', 'grok');
    if (grokBin) await sweepShadowHomes(grokHomesDir).catch((err: unknown) => console.error('deck: sweeping Grok shadow homes failed', err instanceof Error ? err.message : err));
    const grokDeps = grokBin ? {
      bin: grokBin, grokHome: cfg.grokHome, homesDir: grokHomesDir, realHome: cfg.home,
      inspect: (env: Record<string, string>, cwd: string) => runGrokInspect(grokBin, env, cwd), children,
    } : null;
    const grok = grokDeps ? { run: (req: Parameters<typeof runGrokTurn>[0]) => runGrokTurn(req, grokDeps) } : null;
    // Grok usage card (usage header design §4/§7-4): deck's own Grok turns, plus the subscription's usage (`_x.ai/billing`)
    // read at the end of each turn and, while idle, by the poller (same deps — shadow HOME, env, grok inspect — as a turn).
    const grokUsage = grokBin ? new GrokUsageTracker({ file: path.join(cfg.configDir, 'grok-usage.json'), usage, log: (line) => console.error(line) }) : null;
    const grokBilling = grokDeps && grokUsage
      ? new GrokBillingPoller({ probe: (signal) => probeGrokBilling(grokDeps, undefined, signal), tracker: grokUsage, busy: () => grokLock.size > 0, log: (line) => console.error(line) })
      : null;
    grokBilling?.start();
    cleanup.push(() => void grokBilling?.stop());
    const grokStatusBase: GrokStatus = { bin: grok !== null };
    const grokStatus = (): GrokStatus => ({ ...grokStatusBase, locked: grokEngineLock.reason });
    if (grokBin) {
      execFile(grokBin, ['--version'], { timeout: 5_000, env: grokEnv(process.env, cfg.grokHome) }, (err, stdout) => {
        const v = String(stdout ?? '').trim().split('\n')[0];
        if (!err && v) grokStatusBase.version = v.slice(0, 120);
      });
    }

    // The socket layer is created after the HTTP handler; index changes made over HTTP (F1/F2) or by a fork reach it through this.
    let notifyIndex = () => {};
    let notifyPermissionMode: (sessionId: string, mode: PermMode) => void = () => {};
    const claude = new ClaudeEngine({ bin: cfg.claudeBin, accounts, ...(claudeScripts ? { scripts: claudeScripts } : {}), bgMaxMs: cfg.bgMaxMs, steer: cfg.steer, promptSuggestions: cfg.promptSuggestions, onCommands: (sessionId, cwd, list, terminal) => commands.record(sessionId, cwd, list, terminal) });
    cleanup.push(() => void claude.close().catch(() => undefined));
    const runner = new TurnRunner({
      engine: claude,
      // 삭제 took a booked 자동으로 이어가기 along: its timer goes and every device's line now.
      retryGone: (sessionId) => { if (!watch.cancelRetry(sessionId)) broadcastAll({ type: 'auto_resume', sessionId, atMs: null }); },
      memory: () => memory.get(),
      holders,
      codex,
      gemini,
      geminiUsage,
      grok,
      grokUsage,
      attachments,
      codexSessionsRoot: cfg.codexSessionsRoot,
      usage,
      index,
      store,
      cooldownDir: cfg.cooldownDir,
      protectedAccount: cfg.protectedAccount,
      auditFile: cfg.auditFile,
      defaultPermissionMode: () => settings.get().defaultPermissionMode,
      routingPolicy: () => settings.get().routingPolicy,
      sameVendorRotation: () => settings.get().sameVendorRotation,
      autoRoute: () => { const c = settings.get(); return { autoEngines: c.autoEngines, autoConsent: c.autoConsent, grokFast: c.grokFast }; },
      crossEngineFailover: () => settings.get().crossEngineFailover,
      autoResume: () => settings.get().autoResume,
      devCommanderGate: cfg.devCommanderGate,
      routeLog: (line) => console.log(line),
      onPermissionMode: (sessionId, mode) => notifyPermissionMode(sessionId, mode),
      accounts,
      projectsRoots: cfg.projectsRoots,
      homeAccount: accounts.home,
      desktopMirror: () => experimental().desktop,
      onIndexChanged: () => notifyIndex(),
    });

    // Deviation (added per review I5): the addresses deck itself binds to double as the
    // Host allowlist (DNS-rebinding defence), plus any operator-configured extra names.
    // PWA: the MagicDNS name too, so `tailscale serve` (https://<name>/ → 127.0.0.1:port) is accepted without DECK_EXTRA_HOSTS.
    const dnsName = cfg.loopbackOnly ? null : tailscaleDnsName();
    const extraHosts = [...addresses, ...(dnsName ? [dnsName] : []), ...cfg.extraHosts];
    const titleOf = (sessionId: string | null, cwd: string) => (sessionId ? index.lookup(sessionId)?.title ?? index.codexOwned(store.codexEntries()).find((e) => e.sessionId === sessionId)?.title : undefined) ?? cwd.split('/').filter(Boolean).pop() ?? 'AI-MSG';
    const push = new PushNotifier({
      store: pushSubs,
      vapid: await loadOrCreateVapid(cfg.vapidFile),
      subject: cfg.vapidSubject ?? (dnsName ? `https://${dnsName}` : 'mailto:deck@localhost.localdomain'),
      titleOf,
      // 자동 턴 결과는 사령탑이 실제로 돌 때만 사령탑에 맡긴다(paused·stopped 뒤 끝난 자동 턴은 여느 턴처럼).
      commanderQuiet: (sessionId) => commander.quiet(sessionId),
      taskTurn: (turnId) => ws.isTaskTurn(turnId),
      conciseTurn: (turnId) => ws.isConciseTurn(turnId),
    });
    // 하이라이트: what push would announce (plus restart cuts and server start/drain), kept 7 days in events.jsonl.
    const events = new EventLog(path.join(cfg.configDir, 'events.jsonl'), { titleOf });
    // 병목 알림: unanswered cards and failed turns pushed again later; 대안 계정 없음 retries fired through the socket layer's send path.
    let submitRetry: (r: RetryRequest) => boolean | void = () => {};
    const watch = new BottleneckWatch({
      sendPush: (payload) => { void push.sendAll(payload); },
      titleOf,
      store,
      earliestCooldownMs: () => { const v = Object.values(readAllCooldownsMs(cfg.cooldownDir, Date.now(), accounts.list())).filter((x): x is number => x !== undefined); return v.length ? Math.min(...v) : null; },
      retry: (r) => submitRetry(r),
      // 자동으로 이어가기 line on every device (armed with its time, gone = null).
      onRetry: (sessionId, atMs) => broadcastAll({ type: 'auto_resume', sessionId, atMs }),
      // 자동으로 이어가기 off: a booking is not fired (one left by a failed drop).
      enabled: () => settings.get().autoResume,
      // 총사령탑이 맡은 세션의 실패는 사령탑이 사람 필요로 푸시한다(설계 §5 중복 푸시).
      quiet: (sessionId) => commander.quiet(sessionId),
    });
    cleanup.push(() => watch.stop());
    // 총사령탑: ws 가 생긴 뒤 묶이는 전송·busy·방송.
    let serverSend: (r: ServerSend) => boolean = () => false;
    let sessionBusy: (sessionId: string) => boolean = () => true;
    let broadcastAll: (m: ServerMessage) => void = () => {};
    const commander = new Commander({
      store,
      judge: async (input, sessionId) => {
        const st = store.get(sessionId);
        if (!st || isOtherEngineState(st) || !cfg.claudeBin.ok) {
          return { verdict: { verdict: 'human', reason: '판정기를 실행할 수 없습니다', confidence: 'low' }, failed: true, usage: null, account: null };
        }
        // 고정 계정이 있거나 같은 계열 회전이 꺼져 있으면 세션 계정, 아니면 sonnet 라우팅이 고를 계정(§3).
        const account = st.accountPin || !settings.get().sameVendorRotation ? st.account : (runner.previewRoute(sessionId, 'sonnet')?.account ?? st.account);
        const r = await judge(input, accounts.env(account, process.env), { bin: cfg.claudeBin.bin, configDir: cfg.configDir });
        return { ...r, account };
      },
      send: (r) => serverSend(r),
      isBusy: (sessionId) => sessionBusy(sessionId),
      permissionModeOf: (sessionId) => runner.permissionModeOf(sessionId),
      push: (payload) => { void push.sendAll(payload); },
      record: (m) => events.record(m),
      audit: (e) => { void recordAudit(cfg.auditFile, e); },
      broadcast: (m) => broadcastAll(m),
      enabled: () => settings.get().commanderEnabled === true,
      limits: () => ({ maxTurns: settings.get().commanderMaxTurns ?? 20, tokenCap: settings.get().commanderTokenCap ?? 2_000_000 }),
      titleOf,
    });
    cleanup.push(() => commander.dispose());
    await events.load();
    const updates = new ServerUpdateWatch({ root: cfg.repoRoot, startedAt, version: packageVersion() });
    await updates.start();
    // Bound once installGracefulShutdown has run (after listening).
    let restartCtl: ReturnType<typeof installGracefulShutdown> = { draining: () => false, request: () => {}, force: () => false };
    const serverUpdate: ServerUpdateDeps = { check: () => updates.check(), supervised: supervisionCheck({ supervisor: cfg.supervisor, pidFile: path.join(cfg.configDir, 'relaunch.pid') }), draining: () => restartCtl.draining(), activeTurns: () => ws.activeTurns(), restart: () => restartCtl.request('UI 재시작'), forceRestart: () => restartCtl.force('UI 강제 재시작') };
    const setup = new SetupService({ cfg, accounts, store: setupStore, supervised: serverUpdate.supervised, addresses: [...addresses.map((a) => `http://${a.includes(':') ? `[${a}]` : a}:${port}`), ...(dnsName ? [`https://${dnsName}/`] : [])] });
    const realHandler = createRequestHandler({ token, uiDir: cfg.uiDir, build: () => liveBuildId(cfg.uiDir), usage, index, devOrigins: cfg.devOrigins, extraHosts, extraSessions: () => store.codexEntries(), attachments, home: cfg.home, onIndexChanged: () => notifyIndex(), pins, memory, meta, search, files, commands, push: { notifier: push, store: pushSubs }, forks: runner, trash: runner, usageHistory, highlights: events, serverUpdate, setup });
    const ws = attachWebSocket(servers, { holders, grokHome: cfg.grokBin ? cfg.grokHome : null, build: () => liveBuildId(cfg.uiDir), token, devOrigins: cfg.devOrigins, runner, index, usage, store, extraHosts, codexAvailable: codex !== null, accounts, geminiStatus, grokStatus, grokUnlock: () => grokEngineLock.unlock(), cwdRoots: cfg.cwdRoots, pins, settings, notify: (m) => { push.notify(m); events.record(m); watch.observe(m); commander.observe(m); }, onUserSend: (sessionId) => { watch.userSent(sessionId); commander.userIntervened(sessionId); }, commander, retryDue: (sessionId) => watch.retryDue(sessionId), cancelRetry: (sessionId) => watch.cancelRetry(sessionId), cancelAllRetries: () => watch.cancelAllRetries(), attachments, meta, acceptedRefs: new AcceptedRefs(path.join(cfg.configDir, 'accepted-refs.json')), activityFile: path.join(cfg.configDir, 'activity.json'), tasks, pushTask: (p) => { void push.sendAll(p); }, setup: { needed: () => setupStore.needed() } });
    cleanup.push(() => ws.close());
    notifyIndex = () => ws.broadcastIndex();
    submitRetry = (r) => ws.submitRetry(r);
    serverSend = (r) => ws.submitServerSend(r);
    sessionBusy = (sessionId) => ws.isBusy(sessionId);
    broadcastAll = (m) => ws.broadcast(m);
    // 재시작 전 활성이던 사령탑은 재전송 없이 사람에게(§6) — 재시도 예약을 다시 걸기 전에.
    commander.restore(store.list());
    watch.rearm(store.list());
    index.onChange = () => notifyIndex();
    notifyPermissionMode = (sessionId, mode) => ws.broadcast({ type: 'permission_mode', sessionId, mode });
    // §14.9-3: a tripped (or unlocked) Grok engine is shown in settings at once.
    const stopGrokLockWatch = grokEngineLock.onChange(() => ws.broadcast({ type: 'grok_status', grok: grokStatus() }));
    cleanup.push(stopGrokLockWatch);
    handler = realHandler;

    console.log(`deck: 세션 ${index.sessions().length}개 · 계정 ${accounts.all().map((a) => `${a}${accounts.isRetired(a) ? '(retired)' : ''}${accounts.isHome(a) ? '(home)' : ''}`).join(' ')} · 보호 계정 ${cfg.protectedAccount ?? '없음'} · 사용량 ${cfg.usageMode === 'cli' ? 'cli(턴 관측)' : `usage-deck ${cfg.deckUrl}`} · claude ${claudeLabel(cfg.claudeBin)} · codex ${cfg.codexBin ?? '없음'} · agy ${cfg.geminiBin ?? '없음'} · grok ${cfg.grokBin ?? '없음'}`);
    if (cfg.cwdRoots.length > 1) console.log(`deck: 새 세션 추가 허용 경로(DECK_EXTRA_CWD_ROOTS): ${cfg.cwdRoots.slice(1).join(', ')}`);
    for (const a of addresses) console.log(`deck: http://${a}:${port}`);
    if (dnsName) console.log(`deck: https://${dnsName}/ (tailscale serve 로 띄웠을 때 — 폰 앱·알림용)`);
    console.log(`deck: 로그인 토큰은 ${cfg.tokenFile} 에 있습니다 (내용은 출력하지 않음)`);
    events.recordServer('서버 시작');

    // SIGTERM / SIGUSR2 (`npm run restart`): drain, then exit for launchd to restart; SIGINT or a repeat: now.
    const shutdown = (reason: string) => {
      console.log(`deck: 종료 (${reason})`);
      stopGrokLockWatch(); ws.close(); watch.stop(); commander.dispose(); usage.stop(); codexUsage.stop(); claudeUsage?.stop(); geminiUsage?.stop(); usageHistory.stop(); attachments.stop(); stopBackupPruning(); clearInterval(transcriptPruneTimer); for (const s of servers) s.close();
      // grokBilling.stop() aborts an in-progress billing probe; awaited below so shutdown does not race it (review item 5).
      // The permission bridge (unix socket + its temp dir) closes inside the same bounded wait as the event log.
      // The lock goes last: a new server may take the config dir only once this one has written everything.
      void flushThenExit(() => Promise.all([events.flush(), claude.close(), grokBilling?.stop() ?? Promise.resolve()]).then(() => {}), () => { lock.release(); process.exit(0); });
    };
    restartCtl = installGracefulShutdown(process, ws, { maxMs: cfg.drainMaxMs, log: (m) => console.log(m), exit: shutdown, onDrain: () => events.recordServer('재시작 대기') });
    o.onListening?.({ port, addresses, tokenFile: cfg.tokenFile, tokenCreated, lockFile: lock.file });
  } catch (err) {
    // Whatever started is stopped in reverse order, so nothing keeps the process alive after the error.
    for (const stop of cleanup.reverse()) {
      try { stop(); } catch (e) { console.error('deck: 시작 실패 후 정리 중 오류', e instanceof Error ? e.message : e); }
    }
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => { if (!s.listening) resolve(); else s.close(() => resolve()); })));
    lock.release();
    throw err;
  }
}

const claudeLabel = (b: ClaudeBin) => (b.ok ? `${b.version}${b.belowRecommended ? ` (${RECOMMENDED_CLAUDE_VERSION} 이상 권장)` : ''}` : b.reason === 'too_old' ? `${b.version} (너무 오래됨 — ${MIN_CLAUDE_VERSION} 이상 필요)` : '없음');
