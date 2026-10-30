/** Number and time texts for the mini page and its tests: no React, no server imports. */

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function fmtCost(usd: number | null): string {
  if (usd === null) return '—';
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

/** How long ago, coarsely: 방금 · N초 · N분 · N시간 · N일. */
export function ago(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return '방금';
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86_400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86_400)}일 전`;
}

/** A running turn's length: 12초 · 3분 · 1시간 5분. */
export function forText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}초`;
  if (s < 3600) return `${Math.floor(s / 60)}분`;
  return `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분`;
}

/** Until an ISO reset: 2h 10m · 3d 4h · 지남 (past) · — (none). */
export function countdown(iso: string | null, now: number): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const m = Math.round((t - now) / 60_000);
  if (m <= 0) return '지남';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
