import { computeBuildId } from './buildId';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AttachmentStore } from './attachments/AttachmentStore';
import { loadOrCreateToken } from './auth';
import { bindAddresses, tailscaleDnsName, tailscaleIPv4s } from './bind';
import { loadConfig } from './config';
import { ClaudeEngine } from './engine/ClaudeEngine';
import { CodexEngine } from './engine/CodexEngine';
import { SlashCommandCache } from './engine/slashCommands';
import { FileLister } from './files';
import { GeminiEngine, geminiLoggedIn } from './engine/GeminiEngine';
import { createRequestHandler } from './http';
import { installGracefulShutdown } from './lifecycle';
import { PushNotifier } from './push/PushNotifier';
import { SubscriptionStore } from './push/SubscriptionStore';
import { loadOrCreateVapid } from './push/vapid';
import { PinStore } from './sessions/PinStore';
import { SessionMetaStore } from './sessions/SessionMetaStore';
import { TranscriptSearch } from './sessions/search';
import { SettingsStore } from './settings';
import { SessionIndex } from './sessions/SessionIndex';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner } from './turn/TurnRunner';
import { CodexUsagePoller } from './usage/CodexUsagePoller';
import { UsageService } from './usage/UsageService';
import { attachWebSocket } from './ws';
import { GEMINI_ACCOUNTS, type GeminiAccount } from '../shared/accounts';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const token = await loadOrCreateToken(cfg.tokenFile);
  const usage = new UsageService({ deckUrl: cfg.deckUrl });
  // Session rename / 보관 live in deck's own config (never in the Claude jsonl); loaded before the first scan.
  const meta = new SessionMetaStore(path.join(cfg.configDir, 'session-meta.json'));
  await meta.load();
  const index = new SessionIndex({ roots: cfg.projectsRoots, pinnedFile: cfg.pinnedFile, recentFile: cfg.recentFoldersFile, desktopRoot: cfg.desktopSessionsRoot, meta });
  const store = new SessionStateStore(cfg.stateFile);
  const pins = new PinStore(cfg.pinsFile);
  const settings = new SettingsStore(cfg.settingsFile);
  const pushSubs = new SubscriptionStore(cfg.pushSubscriptionsFile);
  await Promise.all([index.refresh(), store.load(), pins.load(), settings.load(), pushSubs.load()]);
  const commands = new SlashCommandCache();
  const search = new TranscriptSearch({ sessions: () => index.projects(store.codexEntries()).flatMap((p) => p.sessions) });
  const files = new FileLister({ home: cfg.home, roots: cfg.cwdRoots });
  usage.start();
  // F3: GPT usage from the newest Codex rollouts (Desktop/CLI too), at start and every 60 s.
  const codexUsage = new CodexUsagePoller({ sessionsRoot: cfg.codexSessionsRoot, usage });
  codexUsage.start();
  const attachments = new AttachmentStore(cfg.attachmentsDir);
  await attachments.init();
  attachments.startPurgeTimer();
  // D11: Codex is optional; without the binary the UI hides the GPT option and 'auto' means Claude.
  const codex = cfg.codexBin ? new CodexEngine(cfg.codexBin) : null;
  // Gemini: explicit engine only; an account counts as logged in once its OAuth file exists (never read).
  const geminiLogin = (a: GeminiAccount) => geminiLoggedIn(a, cfg.home);
  const gemini = cfg.geminiBin ? { engine: new GeminiEngine(cfg.geminiBin, cfg.home), loggedIn: geminiLogin } : null;
  const geminiStatus = () => ({ available: gemini !== null, loggedIn: Object.fromEntries(GEMINI_ACCOUNTS.map((a) => [a, gemini !== null && geminiLogin(a)])) as Record<GeminiAccount, boolean> });

  // The socket layer is created after the HTTP handler; index changes made over HTTP (F1/F2) or by a fork reach it through this.
  let notifyIndex = () => {};
  const runner = new TurnRunner({
    engine: new ClaudeEngine({ bgMaxMs: cfg.bgMaxMs, onCommands: (sessionId, cwd, list, terminal) => commands.record(sessionId, cwd, list, terminal) }),
    codex,
    gemini,
    attachments,
    codexSessionsRoot: cfg.codexSessionsRoot,
    usage,
    index,
    store,
    cooldownDir: cfg.cooldownDir,
    protectedAccount: cfg.protectedAccount,
    auditFile: cfg.auditFile,
    autoApprove: () => settings.get().autoApprove,
    projectsRoots: cfg.projectsRoots,
    // Claude Desktop reads/writes A (~/.claude): deck mirrors sessions it ran on B/C back there.
    homeAccount: 'a',
    onIndexChanged: () => notifyIndex(),
  });

  const addresses = bindAddresses(os.networkInterfaces(), { loopbackOnly: cfg.loopbackOnly, tailscaleIps: tailscaleIPv4s() });
  // Deviation (added per review I5): the addresses deck itself binds to double as the
  // Host allowlist (DNS-rebinding defence), plus any operator-configured extra names.
  // PWA: the MagicDNS name too, so `tailscale serve` (https://<name>/ → 127.0.0.1:port) is accepted without DECK_EXTRA_HOSTS.
  const dnsName = cfg.loopbackOnly ? null : tailscaleDnsName();
  const extraHosts = [...addresses, ...(dnsName ? [dnsName] : []), ...cfg.extraHosts];
  const push = new PushNotifier({
    store: pushSubs,
    vapid: await loadOrCreateVapid(cfg.vapidFile),
    subject: cfg.vapidSubject ?? (dnsName ? `https://${dnsName}` : 'mailto:deck@localhost.localdomain'),
    titleOf: (sessionId, cwd) => (sessionId ? index.lookup(sessionId)?.title ?? store.codexEntries().find((e) => e.sessionId === sessionId)?.title : undefined) ?? cwd.split('/').filter(Boolean).pop() ?? 'deck',
  });
  const handler = createRequestHandler({ token, uiDir: cfg.uiDir, usage, index, devOrigins: cfg.devOrigins, extraHosts, extraSessions: () => store.codexEntries(), attachments, home: cfg.home, onIndexChanged: () => notifyIndex(), pins, meta, search, files, commands, push: { notifier: push, store: pushSubs }, forks: runner });
  const bound = addresses.map((address) => ({ address, server: http.createServer(handler) }));
  const servers = bound.map((b) => b.server);
  const ws = attachWebSocket(servers, { build: computeBuildId(cfg.uiDir), token, devOrigins: cfg.devOrigins, runner, index, usage, store, extraHosts, codexAvailable: codex !== null, geminiStatus, cwdRoots: cfg.cwdRoots, pins, settings, notify: (m) => push.notify(m), attachments, meta });
  notifyIndex = () => ws.broadcastIndex();
  await Promise.all(bound.map(({ address, server }) => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, address, resolve); })));

  console.log(`deck: 세션 ${index.sessions().length}개 · 보호 계정 ${cfg.protectedAccount ?? '없음'} · usage-deck ${cfg.deckUrl} · codex ${cfg.codexBin ?? '없음'} · gemini ${cfg.geminiBin ?? '없음'}`);
  if (cfg.cwdRoots.length > 1) console.log(`deck: 새 세션 추가 허용 경로(DECK_EXTRA_CWD_ROOTS): ${cfg.cwdRoots.slice(1).join(', ')}`);
  for (const a of addresses) console.log(`deck: http://${a}:${cfg.port}`);
  if (dnsName) console.log(`deck: https://${dnsName}/ (tailscale serve 로 띄웠을 때 — 폰 앱·알림용)`);
  console.log(`deck: 로그인 토큰은 ${cfg.tokenFile} 에 있습니다 (내용은 출력하지 않음)`);

  // SIGTERM / SIGUSR2 (`npm run restart`): drain, then exit for launchd to restart; SIGINT or a repeat: now.
  const shutdown = (reason: string) => {
    console.log(`deck: 종료 (${reason})`);
    ws.close(); usage.stop(); codexUsage.stop(); attachments.stop(); for (const s of servers) s.close();
    setTimeout(() => process.exit(0), 200);
  };
  installGracefulShutdown(process, ws, { maxMs: cfg.drainMaxMs, log: (m) => console.log(m), exit: shutdown });
}

main().catch((err: unknown) => { console.error('deck: 시작 실패', err); process.exit(1); });
