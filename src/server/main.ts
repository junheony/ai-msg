import { liveBuildId } from './buildId';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AttachmentStore } from './attachments/AttachmentStore';
import { loadOrCreateToken } from './auth';
import { bindAddresses, tailscaleDnsName, tailscaleIPv4s } from './bind';
import { AccountsFileError } from './accounts';
import { loadConfig } from './config';
import { ClaudeEngine } from './engine/ClaudeEngine';
import { MIN_CLAUDE_VERSION, RECOMMENDED_CLAUDE_VERSION, type ClaudeBin } from './engine/claudeCli/version';
import { CodexEngine } from './engine/CodexEngine';
import { SlashCommandCache } from './engine/slashCommands';
import { FileLister } from './files';
import { GeminiEngine, GeminiLogin } from './engine/GeminiEngine';
import { createRequestHandler, type ServerUpdateDeps } from './http';
import { ServerUpdateWatch, supervisionCheck } from './serverUpdate';
import { installCrashHandlers } from './crash';
import { flushThenExit, installGracefulShutdown } from './lifecycle';
import { EventLog } from './highlights';
import { BottleneckWatch, type RetryRequest } from './push/BottleneckWatch';
import { PushNotifier } from './push/PushNotifier';
import { readAllCooldownsMs } from './routing/cooldown';
import { SubscriptionStore } from './push/SubscriptionStore';
import { loadOrCreateVapid } from './push/vapid';
import { PinStore } from './sessions/PinStore';
import { pruneRootsOf, startBackupPruning } from './sessions/backupPrune';
import { SessionMetaStore } from './sessions/SessionMetaStore';
import { AcceptedRefs } from './sessions/AcceptedRefs';
import { TranscriptSearch } from './sessions/search';
import { pruneTranscriptSnapshots, setTranscriptCacheDir } from './sessions/transcript';
import { SettingsStore } from './settings';
import { ProcessHolders } from './sessions/ProcessHolders';
import { SessionIndex } from './sessions/SessionIndex';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner } from './turn/TurnRunner';
import { CodexUsagePoller } from './usage/CodexUsagePoller';
import { GeminiUsagePoller } from './usage/GeminiUsagePoller';
import { UsageIndex } from './usage/UsageIndex';
import { UsageService } from './usage/UsageService';
import { attachWebSocket, type ServerSend } from './ws';
import { recordAudit } from './audit';
import { Commander } from './commander/Commander';
import { judge } from './commander/Judge';
import { isCodexState, isGeminiState } from './turn/SessionState';
import { GEMINI_ACCOUNTS, type GeminiAccount } from '../shared/accounts';
import type { PermMode } from '../shared/permission';
import type { ServerMessage } from '../shared/protocol';

async function main(): Promise<void> {
  // When this process started: code edited later is what a restart would bring in.
  const startedAt = Date.now() - Math.round(process.uptime() * 1000);
  const cfg = loadConfig();
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
  const token = await loadOrCreateToken(cfg.tokenFile);
  const accounts = cfg.accounts;
  const usage = new UsageService({ mode: cfg.usageMode, observedFile: cfg.claudeUsageFile, deckUrl: cfg.deckUrl, accounts, usageSourceFile: cfg.usageSourceFile, strict: cfg.usageStrict, deckConfigured: cfg.deckUrlConfigured, log: (line) => console.error(line) });
  // Session rename / 보관 live in deck's own config (never in the Claude jsonl); loaded before the first scan.
  const meta = new SessionMetaStore(path.join(cfg.configDir, 'session-meta.json'));
  await meta.load();
  // Sessions another `claude` process (Claude Desktop, a terminal) holds open: read-only `ps`, never deck's own CLI children.
  const holders = new ProcessHolders();
  const index = new SessionIndex({ holders, roots: cfg.projectsRoots, pinnedFile: cfg.pinnedFile, recentFile: cfg.recentFoldersFile, desktopRoot: cfg.desktopSessionsRoot, codexRoot: cfg.codexSessionsRoot, codexArchivedRoot: cfg.codexArchivedRoot, meta, home: accounts.home });
  const store = new SessionStateStore(cfg.stateFile);
  const pins = new PinStore(cfg.pinsFile);
  const settings = new SettingsStore(cfg.settingsFile);
  const pushSubs = new SubscriptionStore(cfg.pushSubscriptionsFile);
  // Codex rollouts (~1000 files) are read after listening; the sidebar is told when they are in.
  await Promise.all([holders.refresh().then(() => index.refresh({ codexInBackground: true })), store.load(), pins.load(), settings.load(), pushSubs.load()]);
  const commands = new SlashCommandCache();
  const search = new TranscriptSearch({ sessions: () => index.projects(store.codexEntries(), { all: true }).flatMap((p) => p.sessions) });
  // /api/file never previews deck's own config (token, VAPID key, push subscriptions), even with the cwd at ~.
  const files = new FileLister({ home: cfg.home, roots: cfg.cwdRoots, denyRoots: [await fs.realpath(cfg.configDir).catch(() => cfg.configDir)] });
  usage.start();
  // F3: GPT usage from the newest Codex rollouts (Desktop/CLI too), at start and every 60 s.
  const codexUsage = new CodexUsagePoller({ sessionsRoot: cfg.codexSessionsRoot, usage });
  codexUsage.start();
  // 사용량 view: incremental token usage index over every transcript/rollout; first scan runs in the background.
  const usageHistory = new UsageIndex({ projectsRoots: cfg.projectsRoots, codexSessionsRoot: cfg.codexSessionsRoot, indexFile: cfg.usageIndexFile, legacyIndexFile: cfg.usageIndexV1File });
  usageHistory.start();
  const attachments = new AttachmentStore(cfg.attachmentsDir);
  await attachments.init();
  attachments.startPurgeTimer();
  // Fork backups (SessionFork) and the 삭제 trash (SessionTrash) live in each profile's config dir; only deck-named, expired entries go.
  const stopBackupPruning = startBackupPruning(accounts.all().flatMap((a) => pruneRootsOf(accounts.profileDir(a))), cfg.backupRetentionDays);
  // D11: Codex is optional; without the binary the UI hides the GPT option and 'auto' means Claude.
  const codex = cfg.codexBin ? new CodexEngine(cfg.codexBin) : null;
  // Gemini (agy): explicit engine only; logged in = an `agy models` probe exited 0 (cached 5 min, checked in the background).
  const geminiLogin = cfg.geminiBin ? new GeminiLogin(cfg.geminiBin) : null;
  void geminiLogin?.refresh();
  const gemini = cfg.geminiBin && geminiLogin ? { engine: new GeminiEngine(cfg.geminiBin), loggedIn: (a: GeminiAccount) => geminiLogin.get(a) } : null;
  // Gemini quota for the usage card: `agy -p=/usage` at start, every 5 min, and after each Gemini turn — only while logged in.
  const geminiUsage = cfg.geminiBin && geminiLogin ? new GeminiUsagePoller({ bin: cfg.geminiBin, usage, login: geminiLogin }) : null;
  geminiUsage?.start();
  const geminiStatus = () => {
    geminiLogin?.ensureFresh();
    return { available: gemini !== null, loggedIn: Object.fromEntries(GEMINI_ACCOUNTS.map((a) => [a, geminiLogin?.get(a) ?? false])) as Record<GeminiAccount, boolean> };
  };

  // The socket layer is created after the HTTP handler; index changes made over HTTP (F1/F2) or by a fork reach it through this.
  let notifyIndex = () => {};
  let notifyPermissionMode: (sessionId: string, mode: PermMode) => void = () => {};
  const claude = new ClaudeEngine({ bin: cfg.claudeBin, accounts, bgMaxMs: cfg.bgMaxMs, steer: cfg.steer, onCommands: (sessionId, cwd, list, terminal) => commands.record(sessionId, cwd, list, terminal) });
  const runner = new TurnRunner({
    engine: claude,
    codex,
    gemini,
    geminiUsage,
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
    devCommanderGate: cfg.devCommanderGate,
    routeLog: (line) => console.log(line),
    onPermissionMode: (sessionId, mode) => notifyPermissionMode(sessionId, mode),
    accounts,
    projectsRoots: cfg.projectsRoots,
    homeAccount: accounts.home,
    onIndexChanged: () => notifyIndex(),
  });

  const addresses = bindAddresses(os.networkInterfaces(), { loopbackOnly: cfg.loopbackOnly, tailscaleIps: tailscaleIPv4s() });
  // Deviation (added per review I5): the addresses deck itself binds to double as the
  // Host allowlist (DNS-rebinding defence), plus any operator-configured extra names.
  // PWA: the MagicDNS name too, so `tailscale serve` (https://<name>/ → 127.0.0.1:port) is accepted without DECK_EXTRA_HOSTS.
  const dnsName = cfg.loopbackOnly ? null : tailscaleDnsName();
  const extraHosts = [...addresses, ...(dnsName ? [dnsName] : []), ...cfg.extraHosts];
  const titleOf = (sessionId: string | null, cwd: string) => (sessionId ? index.lookup(sessionId)?.title ?? index.codexOwned(store.codexEntries()).find((e) => e.sessionId === sessionId)?.title : undefined) ?? cwd.split('/').filter(Boolean).pop() ?? 'deck';
  const push = new PushNotifier({
    store: pushSubs,
    vapid: await loadOrCreateVapid(cfg.vapidFile),
    subject: cfg.vapidSubject ?? (dnsName ? `https://${dnsName}` : 'mailto:deck@localhost.localdomain'),
    titleOf,
    // 자동 턴 결과는 사령탑이 실제로 돌 때만 사령탑에 맡긴다(paused·stopped 뒤 끝난 자동 턴은 여느 턴처럼).
    commanderQuiet: (sessionId) => commander.quiet(sessionId),
  });
  // 하이라이트: what push would announce (plus restart cuts and server start/drain), kept 7 days in events.jsonl.
  const events = new EventLog(path.join(cfg.configDir, 'events.jsonl'), { titleOf });
  // 병목 알림: unanswered cards and failed turns pushed again later; 대안 계정 없음 retries fired through the socket layer's send path.
  let submitRetry: (r: RetryRequest) => void = () => {};
  const watch = new BottleneckWatch({
    sendPush: (payload) => { void push.sendAll(payload); },
    titleOf,
    store,
    earliestCooldownMs: () => { const v = Object.values(readAllCooldownsMs(cfg.cooldownDir, Date.now(), accounts.list())).filter((x): x is number => x !== undefined); return v.length ? Math.min(...v) : null; },
    retry: (r) => submitRetry(r),
    // 총사령탑이 맡은 세션의 실패는 사령탑이 사람 필요로 푸시한다(설계 §5 중복 푸시).
    quiet: (sessionId) => commander.quiet(sessionId),
  });
  // 총사령탑: ws 가 생긴 뒤 묶이는 전송·busy·방송.
  let serverSend: (r: ServerSend) => boolean = () => false;
  let sessionBusy: (sessionId: string) => boolean = () => true;
  let broadcastAll: (m: ServerMessage) => void = () => {};
  const commander = new Commander({
    store,
    judge: async (input, sessionId) => {
      const st = store.get(sessionId);
      if (!st || isCodexState(st) || isGeminiState(st) || !cfg.claudeBin.ok) {
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
  await events.load();
  const updates = new ServerUpdateWatch({ root: cfg.repoRoot, startedAt });
  await updates.start();
  // Bound once installGracefulShutdown has run (after listening).
  let restartCtl: ReturnType<typeof installGracefulShutdown> = { draining: () => false, request: () => {}, force: () => false };
  const serverUpdate: ServerUpdateDeps = { check: () => updates.check(), supervised: supervisionCheck({ env: cfg.supervised, pidFile: path.join(cfg.configDir, 'relaunch.pid') }), draining: () => restartCtl.draining(), activeTurns: () => ws.activeTurns(), restart: () => restartCtl.request('UI 재시작'), forceRestart: () => restartCtl.force('UI 강제 재시작') };
  const handler = createRequestHandler({ token, uiDir: cfg.uiDir, build: () => liveBuildId(cfg.uiDir), usage, index, devOrigins: cfg.devOrigins, extraHosts, extraSessions: () => store.codexEntries(), attachments, home: cfg.home, onIndexChanged: () => notifyIndex(), pins, meta, search, files, commands, push: { notifier: push, store: pushSubs }, forks: runner, trash: runner, usageHistory, highlights: events, serverUpdate });
  const bound = addresses.map((address) => ({ address, server: http.createServer(handler) }));
  const servers = bound.map((b) => b.server);
  const ws = attachWebSocket(servers, { holders, build: () => liveBuildId(cfg.uiDir), token, devOrigins: cfg.devOrigins, runner, index, usage, store, extraHosts, codexAvailable: codex !== null, accounts, geminiStatus, cwdRoots: cfg.cwdRoots, pins, settings, notify: (m) => { push.notify(m); events.record(m); watch.observe(m); commander.observe(m); }, onUserSend: (sessionId) => { watch.userSent(sessionId); commander.userIntervened(sessionId); }, commander, retryDue: (sessionId) => watch.retryDue(sessionId), attachments, meta, acceptedRefs: new AcceptedRefs(path.join(cfg.configDir, 'accepted-refs.json')), activityFile: path.join(cfg.configDir, 'activity.json') });
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
  await Promise.all(bound.map(({ address, server }) => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, address, resolve); })));

  console.log(`deck: 세션 ${index.sessions().length}개 · 계정 ${accounts.all().map((a) => `${a}${accounts.isRetired(a) ? '(retired)' : ''}${accounts.isHome(a) ? '(home)' : ''}`).join(' ')} · 보호 계정 ${cfg.protectedAccount ?? '없음'} · 사용량 ${cfg.usageMode === 'cli' ? 'cli(턴 관측)' : `usage-deck ${cfg.deckUrl}`} · claude ${claudeLabel(cfg.claudeBin)} · codex ${cfg.codexBin ?? '없음'} · agy ${cfg.geminiBin ?? '없음'}`);
  if (cfg.cwdRoots.length > 1) console.log(`deck: 새 세션 추가 허용 경로(DECK_EXTRA_CWD_ROOTS): ${cfg.cwdRoots.slice(1).join(', ')}`);
  for (const a of addresses) console.log(`deck: http://${a}:${cfg.port}`);
  if (dnsName) console.log(`deck: https://${dnsName}/ (tailscale serve 로 띄웠을 때 — 폰 앱·알림용)`);
  console.log(`deck: 로그인 토큰은 ${cfg.tokenFile} 에 있습니다 (내용은 출력하지 않음)`);
  events.recordServer('서버 시작');

  // SIGTERM / SIGUSR2 (`npm run restart`): drain, then exit for launchd to restart; SIGINT or a repeat: now.
  const shutdown = (reason: string) => {
    console.log(`deck: 종료 (${reason})`);
    ws.close(); watch.stop(); commander.dispose(); usage.stop(); codexUsage.stop(); geminiUsage?.stop(); usageHistory.stop(); attachments.stop(); stopBackupPruning(); clearInterval(transcriptPruneTimer); for (const s of servers) s.close();
    // The permission bridge (unix socket + its temp dir) closes inside the same bounded wait as the event log.
    void flushThenExit(() => Promise.all([events.flush(), claude.close()]).then(() => {}), () => process.exit(0));
  };
  restartCtl = installGracefulShutdown(process, ws, { maxMs: cfg.drainMaxMs, log: (m) => console.log(m), exit: shutdown, onDrain: () => events.recordServer('재시작 대기') });
}

const claudeLabel = (b: ClaudeBin) => (b.ok ? `${b.version}${b.belowRecommended ? ` (${RECOMMENDED_CLAUDE_VERSION} 이상 권장)` : ''}` : b.reason === 'too_old' ? `${b.version} (너무 오래됨 — ${MIN_CLAUDE_VERSION} 이상 필요)` : '없음');

installCrashHandlers(process, { log: (line) => console.error(line), exit: (code) => process.exit(code) });

main().catch((err: unknown) => {
  // A broken accounts.json: the message already says which file, why, and what to do — no stack.
  if (err instanceof AccountsFileError) console.error(err.message);
  else console.error('deck: 시작 실패', err);
  process.exit(1);
});
