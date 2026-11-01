/// <reference types="vite/client" />
import type { MiniStatus } from '../../shared/mini-types';
import { applyBars, renderHead, renderLogin, renderStatus, updateTimes } from './render';
import './mini.css';

export const MINI_POLL_MS = 10_000;

const root = document.getElementById('mini')!;
const head = document.createElement('header');
head.className = 'head';
const body = document.createElement('div');
body.className = 'body';
root.append(head, body);
// A live region would read the page out on every rebuild and every moving time text.
root.removeAttribute('aria-live');

let status: MiniStatus | null = null;
let fetchedAt: number | null = null;
let error: string | null = null;
let needLogin = false;
let inflight: AbortController | null = null;
let headHtml = '';
let bodyHtml = '';

function paint(): void {
  const now = Date.now();
  const nextHead = renderHead(status, fetchedAt, now, error);
  if (nextHead !== headHtml) {
    const refocus = !!document.activeElement?.closest('.refresh');
    head.innerHTML = headHtml = nextHead;
    if (refocus) head.querySelector<HTMLElement>('.refresh')?.focus();
  }
  const nextBody = needLogin ? renderLogin() : status ? renderStatus(status, now) : error ? bodyHtml : '<p class="empty">…</p>';
  if (nextBody !== bodyHtml) {
    const from = Array.from(body.querySelectorAll<HTMLElement>('.bar i'), (el) => el.style.width);
    body.innerHTML = bodyHtml = nextBody;
    applyBars(body, from);
  }
  // A skipped rebuild can leave older texts from the tick; a rebuilt body still holds the times as fetched.
  updateTimes(head, body, fetchedAt, now);
}

async function load(): Promise<void> {
  if (document.visibilityState === 'hidden') return;
  inflight?.abort();
  const ac = new AbortController();
  inflight = ac;
  try {
    const res = await fetch('/api/mini/status', { cache: 'no-store', signal: ac.signal });
    if (res.status === 401) { needLogin = true; error = null; paint(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = (await res.json()) as MiniStatus;
    if (!next || !Array.isArray(next.sessions)) throw new Error('응답 형식 오류');
    status = next;
    fetchedAt = Date.now();
    error = null;
    needLogin = false;
  } catch (err) {
    if (ac.signal.aborted) return;
    error = err instanceof TypeError ? '서버에 연결할 수 없습니다' : err instanceof Error ? err.message : '오류';
  }
  paint();
}

head.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('.refresh')) void load();
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void load(); });
setInterval(() => { void load(); }, MINI_POLL_MS);
// The "N초 전" texts move even when nothing new came in.
setInterval(() => { if (document.visibilityState === 'visible') updateTimes(head, body, fetchedAt, Date.now()); }, 5000);
paint();
void load();

if (import.meta.env.PROD && window.isSecureContext && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
}
