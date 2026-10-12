/* deck service worker: offline shell for the built assets + Web Push notifications.
 * Never caches /api/* or /ws — only same-origin GETs of the app shell, hashed assets, icons, manifest. */
const CACHE = 'deck-shell-v2'; // v2: new app icon under the same /icons/ names
const MAX_ASSETS = 80;

/* Shown only when the server is unreachable AND no shell is cached yet (first open, or after the cache was cleared):
 * says what is wrong in words, retries by itself, and offers a button — not a bare "오프라인입니다". */
const OFFLINE_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>deck · 연결 안 됨</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.5 -apple-system,system-ui,sans-serif;background:#1f1e1c;color:#e7e5e1;padding:24px;text-align:center}@media(prefers-color-scheme:light){body{background:#f5f4f0;color:#1f1e1c}}main{max-width:28em}h1{font-size:19px;margin:0 0 10px}p{margin:0 0 18px;opacity:.75;font-size:14px}button{font:inherit;font-weight:600;padding:10px 18px;border-radius:10px;border:0;background:#d6a24a;color:#1f1e1c;cursor:pointer}</style></head>
<body><main><h1>deck 서버에 연결할 수 없습니다</h1><p>서버가 꺼져 있거나 Tailscale 연결이 끊겼을 수 있습니다. 10초마다 다시 시도합니다.</p><button onclick="location.reload()">지금 다시 시도</button></main>
<script>setTimeout(function(){location.reload()},10000)</script></body></html>`;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

function isShellAsset(url) {
  return url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest';
}

async function trim(cache) {
  const keys = await cache.keys();
  for (const req of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(req);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/sw.js') return;

  if (req.mode === 'navigate') {
    // Network first; offline → the last shell we saw (index.html is the same document for every path).
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
          const cache = await caches.open(CACHE);
          await cache.put('/', res.clone());
        }
        return res;
      } catch {
        const cached = await caches.match('/');
        return cached || new Response(OFFLINE_HTML, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      }
    })());
    return;
  }

  if (isShellAsset(url)) {
    // Hashed build assets never change under the same name: cache first.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) {
        await cache.put(req, res.clone());
        await trim(cache);
      }
      return res;
    })());
  }
});

// ---- Web Push ----

self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch { p = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Someone is looking at deck right now: the card/result is already on screen. iOS revokes push
    // permission for pushes that show nothing, so there it is always shown.
    const ios = /iPhone|iPad|iPod/.test(self.navigator.userAgent);
    if (!ios && p.kind !== 'test' && wins.some((w) => w.focused && w.visibilityState === 'visible')) return;
    await self.registration.showNotification(p.title || 'deck', {
      body: p.body || '',
      tag: p.tag || undefined,
      renotify: !!p.tag,
      icon: '/icons/icon-192.png',
      // Android draws the badge as a monochrome silhouette: it must be the mark alone on transparency (a colour icon
      // with a background comes out as a white square). iOS ignores both and uses the app icon.
      badge: '/icons/badge-96.png',
      data: { sessionId: p.sessionId || null },
      requireInteraction: p.kind === 'permission' || p.kind === 'question',
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sessionId = (event.notification.data && event.notification.data.sessionId) || null;
  const target = sessionId ? `/?session=${encodeURIComponent(sessionId)}` : '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      if (sessionId) win.postMessage({ type: 'deck-open-session', sessionId });
      await win.focus();
      return;
    }
    await self.clients.openWindow(target);
  })());
});
