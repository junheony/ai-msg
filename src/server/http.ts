import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream';
import type { SessionEntry } from '../shared/session-types';
import { AttachmentTooLarge, IMAGE_TYPES, MAX_ATTACHMENT_BYTES, isAttachmentId, type AttachmentStore } from './attachments/AttachmentStore';
import { DirError, listDirs, resolveUnderHome } from './dirs';
import { isAllowedHost, isAllowedOrigin, isAuthed, loginCookieHeader, logoutCookieHeader, tokenMatches } from './auth';
import type { SlashCommandCache } from './engine/slashCommands';
import { errnoOf, withFileRetry } from './fsRetry';
import { FileReadError, type FileLister } from './files';
import type { PushNotifier } from './push/PushNotifier';
import { isPushEndpoint, parseSubscription, type SubscriptionStore } from './push/SubscriptionStore';
import { MAX_PINS, isPinnableId, type PinStore } from './sessions/PinStore';
import { SessionIconsFullError, type SessionIconStore } from './sessions/SessionIconStore';
import { isSessionIconChoice } from '../shared/sessionIcons';
import { MemoryTooLarge, type MemoryStore } from './memory/MemoryStore';
import { MEMORY_MAX_BYTES } from '../shared/memory';
import { isTrashId } from './sessions/SessionTrash';
import { MAX_TITLE_CHARS, type SessionMetaStore } from './sessions/SessionMetaStore';
import { MAX_QUERY_CHARS, type TranscriptSearch } from './sessions/search';
import type { SessionIndex } from './sessions/SessionIndex';
import type { TurnRunner } from './turn/TurnRunner';
import type { UsageIndex } from './usage/UsageIndex';
import type { EventLog } from './highlights';
import type { ServerUpdate } from './serverUpdate';
import { DEFAULT_HIGHLIGHT_HOURS, HIGHLIGHT_HOURS } from '../shared/highlights';
import type { UsageService } from './usage/UsageService';
import type { ClaudeProfileProbe, SetupStatus } from '../shared/setup-types';
import { ProfileError } from './setup/profiles';
import { PROFILE_TEXTS } from './setup/texts';
import { handleAuthLogin } from './authLogin/http';
import type { AuthLoginHub } from './authLogin/hub';
import type { HubStatusService } from './hub/status';
import { HUB_PROXY_PREFIX, HUB_PROXY_TARGETS, proxyHubRequest, type ProxyTarget } from './hub/proxy';

/** Deviation (added per review I5): devOrigins/extraHosts feed the Origin+Host checks below. */
export type HttpDeps = {
  token: string; uiDir: string; usage: UsageService; index: SessionIndex; devOrigins?: string[]; extraHosts?: string[]; extraSessions?: () => SessionEntry[]; attachments?: AttachmentStore;
  /** UI build id as of now (buildId.ts) for GET /api/build: a visible tab polls it to notice a UI-only rebuild. Absent = null. */
  build?: () => string | null;
  /** F1: the folder picker only reaches inside this dir (default: the OS home dir). */
  home?: string;
  /** F1/F2: the project list or pins changed; main broadcasts a fresh `index` to every socket. */
  onIndexChanged?: () => void;
  /** F2: pinned sessions; absent = no /api/pins. */
  pins?: PinStore;
  /** 직접 고른 세션 아이콘; absent = no /api/session-icon. */
  sessionIcons?: SessionIconStore;
  /** deck 메모 (Settings → 일반); absent = no /api/memory. */
  memory?: MemoryStore;
  /** Session rename / 보관 (session-meta.json); absent = no /api/session-meta. */
  meta?: SessionMetaStore;
  /** Full-text transcript search; absent = no /api/search. */
  search?: TranscriptSearch;
  /** Composer @ file picker; absent = no /api/files. */
  files?: FileLister;
  /** Composer / command menu; absent = no /api/commands. */
  commands?: SlashCommandCache;
  /** Web Push (알림); absent = no /api/push/*. */
  push?: { notifier: PushNotifier; store: SubscriptionStore };
  /** Sessions whose deck and Desktop (home profile) copies diverged; absent = no /api/session-fork. */
  forks?: Pick<TurnRunner, 'forkStatus' | 'resolveFork' | 'openInDesktop'>;
  /** 삭제 (move to session-trash) and its undo; absent = no /api/session-trash. */
  trash?: Pick<TurnRunner, 'trashSession' | 'restoreSession'>;
  /** Token usage history (사용량 view); absent = no /api/usage/history. */
  usageHistory?: Pick<UsageIndex, 'history' | 'refresh'>;
  /** 하이라이트 (events.jsonl); absent = no /api/highlights. */
  highlights?: Pick<EventLog, 'query'>;
  /** 서버 업데이트 대기 / 지금 재시작; absent = no /api/server-update, /api/restart. */
  serverUpdate?: ServerUpdateDeps;
  /** 첫 실행 마법사 (SetupService); absent = no /api/setup*. */
  setup?: SetupDeps;
  /** In-app login window (allowlisted `claude auth login` and the same for Codex / Grok). Absent = no /api/auth-login. */
  authLogin?: AuthLoginHub;
  /** MSG Hub: `GET /api/hub/status` (the overview) and the `/hub/p/<id>/` embed proxy. Absent = 404 for both. */
  hub?: { status: HubStatusService; proxyTargets?: Record<string, ProxyTarget> };
  /** package.json version for GET /api/health and GET /api/version. Absent answers "0.0.0". */
  version?: string;
};

export type SetupDeps = {
  status: (force?: boolean) => Promise<SetupStatus>;
  addProfile: (id: string, label?: string) => Promise<{ profile: ClaudeProfileProbe; restartNeeded: true }>;
  markDone: () => Promise<void>;
};

export type ServerUpdateDeps = {
  check: () => Promise<ServerUpdate>;
  /** A supervisor (relaunch loop / launchd boot) starts the server again after it exits, as of now: only then is a restart offered. */
  supervised: () => Promise<boolean>;
  draining: () => boolean;
  /** Turns/processes the drain still waits for (ws activeTurns). */
  activeTurns: () => number;
  /** The drain SIGUSR2 starts (lifecycle `request`). */
  restart: () => void;
  /** While draining: abort what is left and exit now — a second SIGUSR2 (lifecycle `force`). */
  forceRestart: () => void;
};

export const NOT_DRAINING_MESSAGE = '재시작 대기 중이 아니라 강제로 재시작할 수 없습니다 — 먼저 지금 재시작을 누르세요';

export const UNSUPERVISED_MESSAGE = '이 서버는 자동으로 다시 켜 주는 관리자(relaunch 루프·launchd·systemd) 없이 실행 중이라 여기서 재시작하면 꺼진 채로 남습니다 — 터미널에서 직접 다시 시작하세요. 패키지로 설치했다면 `ai-msg service install` 로 서비스를 등록할 수 있습니다';

/** /api/usage/history: how long `refresh=1` waits for the scan before answering with what is indexed so far. */
const USAGE_REFRESH_WAIT_MS = 15_000;
const MAX_USAGE_DAYS = 400;

/**
 * Review I8: sent on every response. Only documents are governed by CSP; in dev the page is
 * served by Vite (its own origin, no CSP from here), so no relaxed dev policy is needed.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; script-src 'self'; worker-src 'self'; manifest-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/** At most 30 /api/diag lines a minute reach the log. */
const diagWindow = { at: 0, n: 0 };
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/** Deviation (added per review I5): SameSite=Strict doesn't separate ports, so every
 * state-changing /api/* request must also prove it came from our own origin (or an
 * explicit dev origin) — a matching Sec-Fetch-Site: same-origin is accepted too. */
function stateChangingOriginOk(req: http.IncomingMessage, devOrigins: string[]): boolean {
  if (req.headers['sec-fetch-site'] === 'same-origin') return true;
  return isAllowedOrigin(req.headers.origin, req.headers.host, devOrigins);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (data.length > limit) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

class BodyTooLarge extends Error {}

/**
 * PF6: on overflow we must NOT call req.destroy() before the 413 response is written — the
 * client then sees "other side closed" and never gets the size message. Instead: stop
 * buffering (discard further chunks) and reject so the caller can respond immediately; the
 * caller is responsible for draining and eventually closing the socket (see drainAndClose).
 */
function readRaw(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) { cleanup(); reject(new BodyTooLarge()); return; }
      chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onError = (err: Error) => { cleanup(); reject(err); };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * Fix round 1 finding 1: a real oversized upload (tens of MiB) got ECONNRESET/EPIPE instead of
 * seeing the 413 — writing the response with a `connection: close` header makes Node's own
 * http server auto-destroy the socket on `res` 'finish' (`res._last`/`shouldKeepAlive=false`),
 * which races the still-arriving request body: whatever is left unread in the kernel receive
 * buffer at that moment triggers a TCP RST instead of a clean close, and the client sees the
 * RST before it has necessarily read the 413 body. So the 413 response here never sets
 * `connection: close` (keeping Node's own auto-close path from firing at all), and this
 * function alone owns closing the socket: it keeps consuming (discarding) the body — so the
 * client's still-in-flight upload finishes writing instead of hitting EPIPE — until 'end'
 * (then a graceful half-close), or until a bound (time or bytes) is hit (then a hard destroy).
 * Memory stays flat throughout: chunks are counted, never buffered.
 */
function drainAndClose(req: http.IncomingMessage, opts: { maxDrainBytes?: number; timeoutMs?: number } = {}): void {
  const maxDrainBytes = opts.maxDrainBytes ?? 64 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 5000;
  let drained = 0;
  let done = false;
  const finish = (force: boolean) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    req.removeListener('data', onData);
    req.removeListener('end', onEnd);
    req.removeListener('error', onError);
    const sock = req.socket;
    if (!sock || sock.destroyed) return;
    if (force) sock.destroy();
    else sock.end();
  };
  const onData = (chunk: Buffer) => {
    drained += chunk.length;
    if (drained > maxDrainBytes) finish(true);
  };
  const onEnd = () => finish(false);
  const onError = () => finish(true);
  req.on('data', onData);
  req.on('end', onEnd);
  req.on('error', onError);
  const timer = setTimeout(() => finish(true), timeoutMs);
  timer.unref?.();
  req.resume();
}

/** Writes the 413 (deliberately without `connection: close` — see drainAndClose) then drains. */
function tooLarge(req: http.IncomingMessage, res: http.ServerResponse, message: string): void {
  json(res, 413, { error: message });
  drainAndClose(req);
}

/** Shown when index.html is not there yet (dev, or a build that has not written it). */
export const STATIC_NO_BUILD = 'UI 빌드가 없습니다. `npm run build` 를 먼저 실행하세요.';
/** Open failed for a reason that is not "missing" and not a permission denial. */
export const STATIC_UNREADABLE = '파일을 읽지 못했습니다';
/**
 * Open failed with EPERM/EACCES. macOS TCC can refuse ~/Documents to a long-lived node until that process
 * is restarted (or Full Disk Access is granted). The path stays in the server log.
 */
export const STATIC_UNREADABLE_PERM = '파일을 읽지 못했습니다. 권한이 없습니다 — 서버를 다시 시작하거나, macOS라면 전체 디스크 접근에서 node 를 허용하세요.';

/** Extensions the browser would execute or parse. A missing one is 404, never index.html. */
const ASSET_EXT = new Set(['.js', '.mjs', '.css', '.map', '.png', '.svg', '.ico', '.woff2', '.webmanifest', '.json']);
const PERM_OPEN = new Set(['EPERM', 'EACCES']);

/** Status and body for a static open/stat failure. `indexHtml`: the request had already fallen back to the SPA shell. */
export function staticOpenFailure(code: string | undefined, indexHtml: boolean): { status: number; error: string } {
  if (!code || code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
    return indexHtml ? { status: 503, error: STATIC_NO_BUILD } : { status: 404, error: 'not found' };
  }
  if (PERM_OPEN.has(code)) return { status: 500, error: STATIC_UNREADABLE_PERM };
  return { status: 500, error: STATIC_UNREADABLE };
}

function failStatic(res: http.ServerResponse, code: string | undefined, rel: string, indexHtml: boolean): void {
  const mapped = staticOpenFailure(code, indexHtml);
  // 404/503 are ordinary (missing asset, build not written yet). 500 is the outage: log the code and the relative name.
  if (mapped.status === 500) console.error('deck http: static open', code ?? 'ERR', rel);
  if (res.headersSent) { res.destroy(); return; }
  json(res, mapped.status, { error: mapped.error });
}

/** Stream errors after headers are sent must not escape (2026-10-10: an unhandled 'error' took the process down). */
function pipeBody(src: NodeJS.ReadableStream, res: http.ServerResponse, label: string): void {
  pipeline(src, res, (err) => {
    if (!err) return;
    const code = errnoOf(err);
    if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') return;
    console.error(`deck http: ${label}`, code ?? (err instanceof Error ? err.message.split('\n')[0] : err));
    if (!res.writableEnded) res.destroy();
  });
}

async function serveStatic(uiDir: string, urlPath: string, method: string, res: http.ServerResponse): Promise<void> {
  const root = path.resolve(uiDir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    json(res, 400, { error: 'bad path' });
    return;
  }
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const requested = path.resolve(root, '.' + normalized);
  if (!requested.startsWith(root + path.sep) && requested !== root) { json(res, 404, { error: 'not found' }); return; }
  const relReq = path.relative(root, requested);
  const asset = ASSET_EXT.has(path.extname(relReq).toLowerCase());
  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(requested);
  } catch (err) {
    const code = errnoOf(err);
    // Missing is the SPA / 404 path below. Anything else (EPERM on the folder) is the open failure, said as such.
    if (code !== 'ENOENT' && code !== 'ENOTDIR') { failStatic(res, code, relReq || '.', false); return; }
  }
  let file = requested;
  let indexFallback = false;
  if (!st || st.isDirectory()) {
    if (!st && asset) { json(res, 404, { error: 'not found' }); return; }
    file = path.join(root, 'index.html');
    indexFallback = true;
  }
  let fh: fs.promises.FileHandle;
  try {
    // One retry window for an atomic replace (vite writes index.html via rename). Permission errors are not retried.
    fh = await withFileRetry(() => fs.promises.open(file, 'r'));
  } catch (err) {
    failStatic(res, errnoOf(err), indexFallback ? 'index.html' : (path.relative(root, file) || '.'), indexFallback);
    return;
  }
  let streaming = false;
  try {
    const fst = await fh.stat();
    if (!fst.isFile()) {
      json(res, indexFallback ? 503 : 404, { error: indexFallback ? STATIC_NO_BUILD : 'not found' });
      return;
    }
    const rel = path.relative(root, file);
    // PWA: the service worker and manifest are revalidated every time so a new build takes over promptly.
    const cache = rel === 'index.html' ? 'no-store' : rel === 'sw.js' || rel === 'manifest.webmanifest' ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'content-length': String(fst.size),
      'cache-control': cache,
      ...(rel === 'sw.js' ? { 'service-worker-allowed': '/' } : {}),
    });
    if (method === 'HEAD') { res.end(); return; }
    streaming = true;
    // autoClose on the handle's stream closes `fh`. A read error is logged and ends the response; it does not escape.
    pipeBody(fh.createReadStream(), res, 'static read');
  } finally {
    if (!streaming) await fh.close().catch(() => {});
  }
}

/**
 * ux-state: an uploaded IMAGE, for thumbnails in the composer/history. Only ids the store indexed
 * (strict UUID, never a path), only sniffed image types (content-type from the magic bytes, never the
 * client), opened O_NOFOLLOW so a symlink swapped in after indexing is refused. Private cache: the
 * bytes never change for an id.
 */
async function serveAttachment(store: AttachmentStore | undefined, id: string, head: boolean, res: http.ServerResponse): Promise<void> {
  const a = store && isAttachmentId(id) ? store.get(id) : null;
  if (!a || !a.isImage || !IMAGE_TYPES.has(a.mediaType)) { json(res, 404, { error: 'not found' }); return; }
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(a.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    json(res, 404, { error: 'not found' });
    return;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) { json(res, 404, { error: 'not found' }); return; }
    res.writeHead(200, {
      'content-type': a.mediaType,
      'content-length': String(st.size),
      'cache-control': 'private, max-age=604800, immutable',
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
    });
    if (head) { res.end(); return; }
    res.end(await fh.readFile());
  } finally {
    await fh.close();
  }
}

/** Side panel HTML preview: the iframe shell (static, no data, so served without the login check). */
export const PREVIEW_FRAME_PATH = '/api/preview-frame';
/**
 * The shell's OWN policy (it replaces SECURITY_HEADERS for this response). `sandbox allow-scripts` forces an opaque
 * origin even if the page is opened directly, so it can never read deck's cookies/storage or call its API as us;
 * no connect-src/img-src http(s) means no fetch/WebSocket/beacon to deck or anywhere else; inline script/style are
 * allowed only here (the previewed page needs them); frame-ancestors 'self' lets only deck embed it.
 */
export const PREVIEW_FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
// The parent posts the HTML once; the shell replaces itself with it (document.write keeps this response's CSP).
const PREVIEW_FRAME_HTML = '<!doctype html><meta charset="utf-8"><script>addEventListener("message",function(e){if(e.source!==parent||typeof e.data!=="string")return;document.open();document.write(e.data);document.close();},{once:true});</script>';

function servePreviewFrame(res: http.ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': PREVIEW_FRAME_CSP });
  res.end(PREVIEW_FRAME_HTML);
}

export function createRequestHandler(deps: HttpDeps) {
  const devOrigins = deps.devOrigins ?? [];
  const extraHosts = deps.extraHosts ?? [];
  const home = deps.home ?? os.homedir();
  const handle = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    // Deviation (added per review I5): DNS-rebinding defence — reject any Host deck
    // doesn't itself bind to, even though an attacker-controlled Host would still
    // equal its own Origin and pass the check below.
    if (!isAllowedHost(req.headers.host, extraHosts)) { json(res, 421, { error: `host ${req.headers.host ?? ''} not allowed` }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const authed = isAuthed(req.headers.cookie, deps.token);
    // PWA: behind `tailscale serve` (TLS terminated by tailscaled, proxied to 127.0.0.1) the cookie is marked Secure.
    const secure = req.headers['x-forwarded-proto'] === 'https';
    if (url.pathname.startsWith('/api/') && MUTATING_METHODS.has(req.method ?? '') && !stateChangingOriginOk(req, devOrigins)) {
      json(res, 403, { error: '허용되지 않은 출처입니다' });
      return;
    }
    void (async () => {
      if (url.pathname === '/api/login' && req.method === 'POST') {
        let token = '';
        try { token = String((JSON.parse(await readBody(req)) as { token?: unknown }).token ?? ''); } catch { /* fallthrough */ }
        if (!token || !tokenMatches(token, deps.token)) { json(res, 401, { error: '토큰이 올바르지 않습니다' }); return; }
        json(res, 200, { ok: true }, { 'set-cookie': loginCookieHeader(deps.token, secure) });
        return;
      }
      if (url.pathname === '/api/logout' && req.method === 'POST') { json(res, 200, { ok: true }, { 'set-cookie': logoutCookieHeader(secure) }); return; }
      if (url.pathname === PREVIEW_FRAME_PATH && req.method === 'GET') { servePreviewFrame(res); return; }
      if (url.pathname.startsWith('/api/')) {
        // Liveness for a local supervisor (systemd, a human with curl). No cookie, and nothing but ok + version.
        if ((url.pathname === '/api/health' || url.pathname === '/api/version') && req.method === 'GET') {
          json(res, 200, { ok: true, version: deps.version ?? '0.0.0' });
          return;
        }
        if (!authed) { json(res, 401, { error: '로그인이 필요합니다' }); return; }
        if (url.pathname === '/api/me') { json(res, 200, { ok: true }); return; }
        if (url.pathname === '/api/build' && req.method === 'GET') { json(res, 200, { build: deps.build?.() ?? null }); return; }
        // Device-side layout numbers (shellFit.ts) for a problem that only shows on a real device: one log line, nothing stored.
        if (url.pathname === '/api/diag' && req.method === 'POST') {
          const now = Date.now();
          if (now - diagWindow.at > 60_000) { diagWindow.at = now; diagWindow.n = 0; }
          let body: unknown = null;
          try { body = JSON.parse(await readBody(req, 4096)); } catch { /* invalid below */ }
          if (!body || typeof body !== 'object' || Array.isArray(body)) { json(res, 400, { error: '잘못된 요청입니다' }); return; }
          if (++diagWindow.n <= 30) console.log(`deck: diag ${JSON.stringify(body).slice(0, 2000)}`);
          json(res, 200, { ok: true });
          return;
        }
        if (deps.serverUpdate && url.pathname === '/api/server-update' && req.method === 'GET') {
          const su = deps.serverUpdate;
          const [update, supervised] = await Promise.all([su.check(), su.supervised()]);
          json(res, 200, { ...update, supervised, draining: su.draining(), activeTurns: su.activeTurns() });
          return;
        }
        if (deps.serverUpdate && url.pathname === '/api/restart' && req.method === 'POST') {
          const su = deps.serverUpdate;
          let force = false;
          try { force = (JSON.parse(await readBody(req, 4096)) as { force?: unknown } | null)?.force === true; } catch { /* no/invalid body: a plain restart */ }
          if (!(await su.supervised())) { json(res, 409, { error: UNSUPERVISED_MESSAGE }); return; }
          // force (작업 끊고 지금 재시작): only while draining — the second SIGUSR2. Not draining: refused, nothing started.
          if (force) {
            if (!su.draining()) { json(res, 400, { error: NOT_DRAINING_MESSAGE }); return; }
            su.forceRestart();
            json(res, 200, { ok: true, draining: true, forced: true });
            return;
          }
          // Already draining: nothing more without force.
          if (!su.draining()) su.restart();
          json(res, 200, { ok: true, draining: su.draining() });
          return;
        }
        if (url.pathname === '/api/setup' || url.pathname.startsWith('/api/setup/')) {
          const setup = deps.setup;
          if (!setup) { json(res, 404, { error: 'not found' }); return; }
          if (url.pathname === '/api/setup' && req.method === 'GET') { json(res, 200, await setup.status()); return; }
          if (url.pathname === '/api/setup/refresh' && req.method === 'POST') { json(res, 200, await setup.status(true)); return; }
          if (url.pathname === '/api/setup/done' && req.method === 'POST') { await setup.markDone(); json(res, 200, { ok: true }); return; }
          if (url.pathname === '/api/setup/profiles' && req.method === 'POST') {
            let body: { id?: unknown; label?: unknown } = {};
            try { body = JSON.parse(await readBody(req, 4096)) as typeof body; } catch { /* invalid below */ }
            if (!body || typeof body.id !== 'string' || (body.label !== undefined && typeof body.label !== 'string')) { json(res, 400, { error: PROFILE_TEXTS.badRequest }); return; }
            const label = typeof body.label === 'string' && body.label.trim() ? body.label : undefined;
            try {
              const r = await setup.addProfile(body.id, label);
              json(res, 200, { ok: true, profile: r.profile, restartNeeded: true });
            } catch (err) {
              if (err instanceof ProfileError) { json(res, err.status, { error: err.message }); return; }
              throw err;
            }
            return;
          }
          json(res, 404, { error: 'not found' });
          return;
        }
        if (url.pathname === '/api/auth-login' || url.pathname.startsWith('/api/auth-login/')) {
          const authLogin = deps.authLogin;
          if (!authLogin) { json(res, 404, { error: 'not found' }); return; }
          const handled = await handleAuthLogin(req, res, url, authLogin, readBody, json);
          if (handled) return;
        }
        if (url.pathname === '/api/bootstrap') { json(res, 200, { usage: deps.usage.snapshot(), projects: deps.index.projects(deps.extraSessions?.() ?? []), pins: deps.pins?.list() ?? [], sessionIcons: deps.sessionIcons?.list() ?? {}, desktop: deps.index.desktop() }); return; }
        if (url.pathname === '/api/memory' && (req.method === 'GET' || req.method === 'PUT')) {
          if (!deps.memory) { json(res, 404, { error: 'not found' }); return; }
          if (req.method === 'GET') { json(res, 200, { text: deps.memory.get(), max: MEMORY_MAX_BYTES }); return; }
          let body: { text?: unknown } = {};
          try { body = JSON.parse(await readBody(req, 64 * 1024)) as typeof body; } catch { /* invalid below */ }
          if (!body || typeof body.text !== 'string') { json(res, 400, { error: '잘못된 메모 요청입니다' }); return; }
          try {
            json(res, 200, { text: await deps.memory.set(body.text), max: MEMORY_MAX_BYTES });
          } catch (err) {
            if (err instanceof MemoryTooLarge) { json(res, 413, { error: err.message }); return; }
            console.error('deck: 메모 저장 실패', err instanceof Error ? err.message : err);
            json(res, 500, { error: '메모를 저장하지 못했습니다' });
          }
          return;
        }
        if (url.pathname === '/api/pins' && req.method === 'POST') {
          if (!deps.pins) { json(res, 404, { error: 'not found' }); return; }
          let body: { sessionId?: unknown; pinned?: unknown } = {};
          try { body = JSON.parse(await readBody(req)) as typeof body; } catch { /* invalid below */ }
          if (!body || !isPinnableId(body.sessionId) || typeof body.pinned !== 'boolean') { json(res, 400, { error: '잘못된 고정 요청입니다' }); return; }
          const pins = await deps.pins.set(body.sessionId, body.pinned);
          deps.onIndexChanged?.();
          json(res, 200, { pins });
          return;
        }
        if (url.pathname === '/api/session-icon' && req.method === 'POST') {
          if (!deps.sessionIcons) { json(res, 404, { error: 'not found' }); return; }
          let body: { sessionId?: unknown; icon?: unknown } = {};
          try { body = JSON.parse(await readBody(req)) as typeof body; } catch { /* invalid below */ }
          if (!body || !isPinnableId(body.sessionId) || !(body.icon === null || isSessionIconChoice(body.icon))) { json(res, 400, { error: '잘못된 세션 아이콘 요청입니다' }); return; }
          const before = deps.sessionIcons.list();
          let icons: Record<string, string>;
          try {
            icons = await deps.sessionIcons.set(body.sessionId, body.icon);
          } catch (err) {
            if (err instanceof SessionIconsFullError) { json(res, 409, { error: `세션 아이콘은 ${err.max}개까지 저장됩니다 — 다른 세션의 아이콘을 먼저 기본으로 되돌려 주세요` }); return; }
            throw err;
          }
          if (icons !== before) deps.onIndexChanged?.();
          json(res, 200, { sessionIcons: icons });
          return;
        }
        if (url.pathname === '/api/pins/order' && req.method === 'POST') {
          // 고정됨 drag order: the full list, top first; ids that are not pinned are ignored by the store.
          if (!deps.pins) { json(res, 404, { error: 'not found' }); return; }
          let body: { order?: unknown } = {};
          try { body = JSON.parse(await readBody(req)) as typeof body; } catch { /* invalid below */ }
          if (!body || !Array.isArray(body.order) || body.order.length > MAX_PINS * 2 || !body.order.every(isPinnableId)) { json(res, 400, { error: '잘못된 고정 순서 요청입니다' }); return; }
          const before = deps.pins.list();
          const pins = await deps.pins.reorder(body.order);
          if (pins !== before) deps.onIndexChanged?.(); // an unchanged order is not broadcast
          json(res, 200, { pins });
          return;
        }
        if (url.pathname === '/api/session-meta' && req.method === 'POST') {
          if (!deps.meta) { json(res, 404, { error: 'not found' }); return; }
          let body: { sessionId?: unknown; title?: unknown; archived?: unknown } = {};
          try { body = JSON.parse(await readBody(req)) as typeof body; } catch { /* invalid below */ }
          const titleOk = body?.title === undefined || body.title === null || (typeof body.title === 'string' && body.title.length <= MAX_TITLE_CHARS);
          const archivedOk = body?.archived === undefined || typeof body.archived === 'boolean';
          if (!body || !isPinnableId(body.sessionId) || !titleOk || !archivedOk || (body.title === undefined && body.archived === undefined)) { json(res, 400, { error: '잘못된 세션 정보 요청입니다' }); return; }
          const meta = await deps.meta.update(body.sessionId, { ...(body.title !== undefined ? { title: body.title as string | null } : {}), ...(body.archived !== undefined ? { archived: body.archived as boolean } : {}) });
          deps.index.regroup();
          deps.onIndexChanged?.();
          json(res, 200, { meta });
          return;
        }
        if (url.pathname === '/api/session-fork') {
          if (!deps.forks) { json(res, 404, { error: 'not found' }); return; }
          if (req.method === 'GET') {
            const sessionId = url.searchParams.get('sessionId');
            if (!isPinnableId(sessionId)) { json(res, 400, { error: '잘못된 세션입니다' }); return; }
            json(res, 200, (await deps.forks.forkStatus(sessionId)) ?? { diverged: false });
            return;
          }
          if (req.method === 'POST') {
            let body: { sessionId?: unknown; keep?: unknown } = {};
            try { body = JSON.parse(await readBody(req)) as typeof body; } catch { /* invalid below */ }
            if (!body || !isPinnableId(body.sessionId) || (body.keep !== 'deck' && body.keep !== 'home')) { json(res, 400, { error: '잘못된 요청입니다' }); return; }
            const r = await deps.forks.resolveFork(body.sessionId, body.keep);
            if (!r.ok) { json(res, 409, { error: r.error }); return; }
            await deps.index.refresh();
            deps.onIndexChanged?.();
            json(res, 200, r);
            return;
          }
        }
        if ((url.pathname === '/api/session-trash' || url.pathname === '/api/session-trash/restore') && req.method === 'POST') {
          if (!deps.trash) { json(res, 404, { error: 'not found' }); return; }
          let body: { sessionId?: unknown; trashId?: unknown } = {};
          try { body = JSON.parse(await readBody(req)) as typeof body; } catch { /* invalid below */ }
          const restore = url.pathname.endsWith('/restore');
          if (!body || (restore ? !isTrashId(body.trashId) : !isPinnableId(body.sessionId))) { json(res, 400, { error: '잘못된 삭제 요청입니다' }); return; }
          const r = restore ? await deps.trash.restoreSession(body.trashId as string) : await deps.trash.trashSession(body.sessionId as string);
          if (!r.ok) { json(res, 409, { error: r.error }); return; }
          // A trashed session's chosen icon goes with it (a restore comes back with the title emoji or first letter).
          if (!restore) await deps.sessionIcons?.set(body.sessionId as string, null).catch(() => {});
          await deps.index.refresh();
          deps.onIndexChanged?.();
          json(res, 200, r);
          return;
        }
        const openMatch = /^\/api\/sessions\/([^/]+)\/open-in-desktop$/.exec(url.pathname);
        if (openMatch && req.method === 'POST') {
          if (!deps.forks) { json(res, 404, { error: 'not found' }); return; }
          const id = openMatch[1]!;
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) { json(res, 400, { error: '잘못된 세션입니다' }); return; }
          const r = await deps.forks.openInDesktop(id);
          if (r.ok) { json(res, 200, { ok: true, url: `claude://resume?session=${id}`, busy: r.busy }); return; }
          if (r.reason === 'unsupported') { json(res, 400, { error: 'Claude 세션만 Desktop 에서 열 수 있습니다' }); return; }
          if (r.reason === 'diverged') { json(res, 200, { ok: false, reason: 'diverged' }); return; }
          json(res, 500, { error: r.error ?? 'Desktop 사본 갱신 실패' });
          return;
        }
        if (url.pathname === '/api/usage/history' && req.method === 'GET') {
          if (!deps.usageHistory) { json(res, 404, { error: 'not found' }); return; }
          const n = Number(url.searchParams.get('days') ?? 30);
          const days = Number.isInteger(n) ? Math.min(MAX_USAGE_DAYS, Math.max(1, n)) : 30;
          if (url.searchParams.get('refresh') === '1') {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([deps.usageHistory.refresh(), new Promise<void>((r) => { timer = setTimeout(r, USAGE_REFRESH_WAIT_MS); })]);
            clearTimeout(timer);
          }
          json(res, 200, deps.usageHistory.history(days));
          return;
        }
        if (url.pathname === '/api/highlights' && req.method === 'GET') {
          if (!deps.highlights) { json(res, 404, { error: 'not found' }); return; }
          const h = Number(url.searchParams.get('hours'));
          const hours = (HIGHLIGHT_HOURS as readonly number[]).includes(h) ? h : DEFAULT_HIGHLIGHT_HOURS;
          json(res, 200, { hours, events: deps.highlights.query(Date.now() - hours * 3600_000) });
          return;
        }
        if (url.pathname === '/api/search' && req.method === 'GET') {
          if (!deps.search) { json(res, 404, { error: 'not found' }); return; }
          const q = url.searchParams.get('q') ?? '';
          if (q.length > MAX_QUERY_CHARS) { json(res, 400, { error: '검색어가 너무 깁니다' }); return; }
          json(res, 200, await deps.search.search(q));
          return;
        }
        if (url.pathname === '/api/file' && req.method === 'GET') {
          if (!deps.files) { json(res, 404, { error: 'not found' }); return; }
          try {
            // A known session's own folder wins over the client's cwd (a new, unsaved session only has the cwd).
            const sid = url.searchParams.get('session');
            const known = sid ? deps.index.projects(deps.extraSessions?.() ?? [], { all: true }).flatMap((p) => p.sessions).find((e) => e.sessionId === sid) : undefined;
            const cwd = known?.cwd ?? url.searchParams.get('cwd') ?? '';
            const file = url.searchParams.get('path') ?? '';
            if (url.searchParams.get('raw') === '1') {
              // Original bytes (open/download on the device): same check as the preview, streamed from the handle that was checked.
              const r = await deps.files.openRaw(cwd, file);
              const disposition = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
              // RFC 5987 ext-value: encodeURIComponent leaves ' ( ) * ! which attr-char doesn't allow.
              const name = encodeURIComponent(r.name).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
              res.writeHead(200, {
                'content-type': r.contentType,
                'content-length': String(r.size),
                'content-disposition': `${disposition}; filename*=UTF-8''${name}`,
                'x-content-type-options': 'nosniff',
                'cache-control': 'private, no-store',
              });
              // Cut at the size that was announced: a file an agent is still appending to must not overrun Content-Length.
              if (r.size === 0) { void r.fh.close(); res.end(); return; }
              pipeBody(r.fh.createReadStream({ start: 0, end: r.size - 1 }), res, 'file read');
              return;
            }
            json(res, 200, await deps.files.read(cwd, file));
          } catch (err) {
            if (err instanceof DirError) { json(res, 400, { error: err.message }); return; }
            if (err instanceof FileReadError) { json(res, err.status, { error: err.message }); return; }
            throw err;
          }
          return;
        }
        if (url.pathname === '/api/reveal' && req.method === 'POST') {
          // Finder opens on the server Mac's own screen (a remote user sees nothing there); same check as /api/file.
          if (!deps.files) { json(res, 404, { error: 'not found' }); return; }
          let body: { cwd?: unknown; file?: unknown } = {};
          try { body = (JSON.parse(await readBody(req)) as typeof body) ?? {}; } catch { /* invalid below */ }
          if (typeof body.cwd !== 'string' || typeof body.file !== 'string') { json(res, 400, { error: '잘못된 요청입니다' }); return; }
          try {
            await deps.files.reveal(body.cwd, body.file);
          } catch (err) {
            if (err instanceof DirError) { json(res, 400, { error: err.message }); return; }
            if (err instanceof FileReadError) { json(res, err.status, { error: err.message }); return; }
            throw err;
          }
          res.writeHead(204, { 'cache-control': 'no-store' });
          res.end();
          return;
        }
        if (url.pathname === '/api/files' && req.method === 'GET') {
          if (!deps.files) { json(res, 404, { error: 'not found' }); return; }
          try {
            json(res, 200, await deps.files.list(url.searchParams.get('cwd') ?? ''));
          } catch (err) {
            if (err instanceof DirError) { json(res, 400, { error: err.message }); return; }
            throw err;
          }
          return;
        }
        if (url.pathname === '/api/commands' && req.method === 'GET') {
          if (!deps.commands) { json(res, 404, { error: 'not found' }); return; }
          json(res, 200, { commands: deps.commands.get(url.searchParams.get('sessionId'), url.searchParams.get('cwd')) });
          return;
        }
        if (url.pathname.startsWith('/api/push/')) {
          const push = deps.push;
          if (!push) { json(res, 404, { error: 'not found' }); return; }
          if (url.pathname === '/api/push/key' && req.method === 'GET') { json(res, 200, { publicKey: push.notifier.publicKey }); return; }
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return; }
          let body: { subscription?: unknown; endpoint?: unknown } = {};
          try { body = (JSON.parse(await readBody(req)) as typeof body) ?? {}; } catch { /* invalid below */ }
          if (url.pathname === '/api/push/subscribe') {
            const sub = parseSubscription(body.subscription);
            if (!sub) { json(res, 400, { error: '지원하지 않는 알림 구독입니다' }); return; }
            await push.store.add(sub);
            json(res, 200, { ok: true });
            return;
          }
          if (!isPushEndpoint(body.endpoint)) { json(res, 400, { error: '잘못된 알림 구독입니다' }); return; }
          const endpoint = body.endpoint;
          if (url.pathname === '/api/push/unsubscribe') { await push.store.remove(endpoint); json(res, 200, { ok: true }); return; }
          if (url.pathname === '/api/push/status') { json(res, 200, { subscribed: push.store.has(endpoint) }); return; }
          if (url.pathname === '/api/push/test') {
            const ok = await push.notifier.sendTo(endpoint, { kind: 'test', title: 'MSG', body: '테스트 알림입니다', sessionId: null, tag: 'test' });
            json(res, ok ? 200 : 502, ok ? { ok: true } : { error: '알림을 보내지 못했습니다 (구독이 없거나 전송 실패)' });
            return;
          }
          json(res, 404, { error: 'not found' });
          return;
        }
        if (url.pathname === '/api/dirs' && req.method === 'GET') {
          try {
            json(res, 200, await listDirs(url.searchParams.get('path') || '~', home));
          } catch (err) {
            if (err instanceof DirError) { json(res, 400, { error: err.message }); return; }
            throw err;
          }
          return;
        }
        if (url.pathname === '/api/recent-folders' && req.method === 'GET') { json(res, 200, { recent: deps.index.recent() }); return; }
        if (url.pathname === '/api/recent-folders' && req.method === 'POST') {
          let input = '';
          try { input = String((JSON.parse(await readBody(req)) as { path?: unknown }).path ?? ''); } catch { /* fallthrough */ }
          let real: string;
          try {
            real = await resolveUnderHome(input, home);
          } catch (err) {
            if (err instanceof DirError) { json(res, 400, { error: err.message }); return; }
            throw err;
          }
          const recent = await deps.index.addRecent(real);
          deps.onIndexChanged?.();
          json(res, 200, { path: real, recent });
          return;
        }
        if (url.pathname === '/api/attachments' && req.method === 'POST') {
          if (!deps.attachments) { json(res, 404, { error: 'not found' }); return; }
          // Fix round 1 finding 1(a): a declared Content-Length over the limit is rejected
          // before reading any of the body at all.
          const declaredLength = Number(req.headers['content-length']);
          if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_BYTES) {
            tooLarge(req, res, new AttachmentTooLarge().message);
            return;
          }
          let data: Buffer;
          try {
            data = await readRaw(req, MAX_ATTACHMENT_BYTES);
          } catch (err) {
            if (err instanceof BodyTooLarge) { tooLarge(req, res, new AttachmentTooLarge().message); return; }
            throw err;
          }
          let name = 'file';
          try { name = decodeURIComponent(String(req.headers['x-deck-filename'] ?? '')) || 'file'; } catch { /* keep default */ }
          try {
            const a = await deps.attachments.save(name, data);
            json(res, 201, { id: a.id, name: a.name, mediaType: a.mediaType, size: a.size, isImage: a.isImage });
          } catch (err) {
            if (err instanceof AttachmentTooLarge) { json(res, 413, { error: err.message }); return; }
            throw err;
          }
          return;
        }
        // MSG Hub overview: every mode's read-only state, cached 15 s server-side. Never a secret, never an error.
        if (url.pathname === '/api/hub/status') {
          if (req.method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return; }
          if (!deps.hub) { json(res, 404, { error: 'not found' }); return; }
          json(res, 200, await deps.hub.status.status());
          return;
        }
        if (url.pathname.startsWith('/api/attachments/') && (req.method === 'GET' || req.method === 'HEAD')) {
          await serveAttachment(deps.attachments, url.pathname.slice('/api/attachments/'.length), req.method === 'HEAD', res);
          return;
        }
        json(res, 404, { error: 'not found' });
        return;
      }
      // MSG Hub embed proxy (QUANT, OPS): read-only, for the logged-in page only. Method first (nothing to learn from a
      // 405), then the cookie — this is outside /api/, which the block above does not gate.
      if (url.pathname.startsWith(HUB_PROXY_PREFIX)) {
        if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'method not allowed' }); return; }
        if (!authed) { json(res, 401, { error: '로그인이 필요합니다' }); return; }
        if (!deps.hub) { json(res, 404, { error: 'not found' }); return; }
        await proxyHubRequest(req, res, url, deps.hub.proxyTargets ?? HUB_PROXY_TARGETS);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'method not allowed' }); return; }
      await serveStatic(deps.uiDir, url.pathname, req.method ?? 'GET', res);
    })().catch((err: unknown) => {
      // Review M5: details (paths, messages) stay in the server log.
      console.error('deck http: 500', req.method, url.pathname, err);
      if (!res.headersSent) json(res, 500, { error: '서버 내부 오류' });
      else res.destroy();
    });
  };
  // The part before the async block (host check, URL parse, cookie) runs synchronously inside http's 'request' event:
  // a throw there would be an uncaught exception — one bad request must not take the server down.
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    try { handle(req, res); } catch (err) {
      console.error('deck http: 500', req.method, req.url, err);
      if (!res.headersSent) json(res, 500, { error: '서버 내부 오류' });
      else res.destroy();
    }
  };
}
