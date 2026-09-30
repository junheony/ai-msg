import http from 'node:http';
import os from 'node:os';
import { AttachmentStore } from './attachments/AttachmentStore';
import { loadOrCreateToken } from './auth';
import { bindAddresses, tailscaleIPv4s } from './bind';
import { loadConfig } from './config';
import { ClaudeEngine } from './engine/ClaudeEngine';
import { CodexEngine } from './engine/CodexEngine';
import { createRequestHandler } from './http';
import { SessionIndex } from './sessions/SessionIndex';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { attachWebSocket } from './ws';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const token = await loadOrCreateToken(cfg.tokenFile);
  const usage = new UsageService({ deckUrl: cfg.deckUrl });
  const index = new SessionIndex({ roots: cfg.projectsRoots, pinnedFile: cfg.pinnedFile });
  const store = new SessionStateStore(cfg.stateFile);
  await Promise.all([index.refresh(), store.load()]);
  usage.start();
  const attachments = new AttachmentStore(cfg.attachmentsDir);
  await attachments.init();
  attachments.startPurgeTimer();
  // D11: Codex is optional; without the binary the UI hides the GPT option and 'auto' means Claude.
  const codex = cfg.codexBin ? new CodexEngine(cfg.codexBin) : null;

  const runner = new TurnRunner({
    engine: new ClaudeEngine(),
    codex,
    codexSessionsRoot: cfg.codexSessionsRoot,
    usage,
    index,
    store,
    cooldownDir: cfg.cooldownDir,
    protectedAccount: cfg.protectedAccount,
    auditFile: cfg.auditFile,
    projectsRoots: cfg.projectsRoots,
  });

  const addresses = bindAddresses(os.networkInterfaces(), { loopbackOnly: cfg.loopbackOnly, tailscaleIps: tailscaleIPv4s() });
  // Deviation (added per review I5): the addresses deck itself binds to double as the
  // Host allowlist (DNS-rebinding defence), plus any operator-configured extra names.
  const extraHosts = [...addresses, ...cfg.extraHosts];
  const handler = createRequestHandler({ token, uiDir: cfg.uiDir, usage, index, devOrigins: cfg.devOrigins, extraHosts, extraSessions: () => store.codexEntries(), attachments });
  const bound = addresses.map((address) => ({ address, server: http.createServer(handler) }));
  const servers = bound.map((b) => b.server);
  const ws = attachWebSocket(servers, { token, devOrigins: cfg.devOrigins, runner, index, usage, store, extraHosts, codexAvailable: codex !== null });
  await Promise.all(bound.map(({ address, server }) => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, address, resolve); })));

  console.log(`deck: 세션 ${index.sessions().length}개 · 보호 계정 ${cfg.protectedAccount ?? '없음'} · usage-deck ${cfg.deckUrl} · codex ${cfg.codexBin ?? '없음'}`);
  for (const a of addresses) console.log(`deck: http://${a}:${cfg.port}`);
  console.log(`deck: 로그인 토큰은 ${cfg.tokenFile} 에 있습니다 (내용은 출력하지 않음)`);

  const shutdown = () => { ws.close(); usage.stop(); attachments.stop(); for (const s of servers) s.close(); setTimeout(() => process.exit(0), 200); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => { console.error('deck: 시작 실패', err); process.exit(1); });
