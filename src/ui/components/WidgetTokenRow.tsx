import { useState } from 'react';
import { copyText } from '../clipboard';

/** The settings line's texts (tests read them). */
export const WIDGET_TOKEN_TEXTS = {
  label: '위젯 토큰',
  copy: '복사',
  rotate: '재발급',
  confirm: '지금 재발급',
  cancel: '취소',
  copied: '복사됨',
  rotated: '재발급됨 — 복사로 새 토큰을 넣어 주세요',
  copyFailed: '복사하지 못했습니다',
  failed: '서버 응답이 없습니다',
  ask: '재발급하면 지금 쓰는 위젯 토큰은 바로 무효가 됩니다. 위젯에 새 토큰을 다시 넣어야 합니다.',
  hint: '잠금 화면 위젯과 /mini 전용 읽기 토큰입니다. GET /api/mini/status 만 열고, 다른 곳에는 쓸 수 없습니다. 설치: docs/widget.ko.md',
} as const;

async function readToken(res: Response): Promise<string> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const t = ((await res.json()) as { token?: unknown }).token;
  if (typeof t !== 'string' || !t) throw new Error('bad token');
  return t;
}

/**
 * 위젯 토큰 (설정 → 계정): copies the read-only widget token, or rotates it after one confirmation. The token itself
 * is never written to the screen beyond its last four characters (enough to tell which one a phone has).
 */
export function WidgetTokenRow({ fetchFn = (input, init) => fetch(input, init) }: { fetchFn?: (input: string, init?: RequestInit) => Promise<Response> }) {
  const [tail, setTail] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try { await f(); } catch { setNote(WIDGET_TOKEN_TEXTS.failed); } finally { setBusy(false); }
  };
  const copy = () => run(async () => {
    const token = await readToken(await fetchFn('/api/mini/widget-token', { cache: 'no-store' }));
    setTail(token.slice(-4));
    setNote((await copyText(token)) ? WIDGET_TOKEN_TEXTS.copied : WIDGET_TOKEN_TEXTS.copyFailed);
  });
  const rotate = () => run(async () => {
    const token = await readToken(await fetchFn('/api/mini/widget-token/rotate', { method: 'POST', cache: 'no-store' }));
    setAsking(false);
    setTail(token.slice(-4));
    setNote(WIDGET_TOKEN_TEXTS.rotated);
  });
  return (
    <>
      <div className="settings-row widget-token" data-testid="widget-token-row">
        <span>{WIDGET_TOKEN_TEXTS.label}{tail && <span className="widget-token-tail" aria-label="토큰 끝 네 자리"> ····{tail}</span>}</span>
        <div className="widget-token-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => { void copy(); }}>{WIDGET_TOKEN_TEXTS.copy}</button>
          <button type="button" className="btn ghost" disabled={busy || asking} onClick={() => { setNote(null); setAsking(true); }}>{WIDGET_TOKEN_TEXTS.rotate}</button>
        </div>
      </div>
      {asking && (
        <div className="settings-consent" role="group" aria-label="위젯 토큰 재발급">
          <p>{WIDGET_TOKEN_TEXTS.ask}</p>
          <div className="settings-row">
            <button type="button" className="btn" disabled={busy} onClick={() => { void rotate(); }}>{WIDGET_TOKEN_TEXTS.confirm}</button>
            <button type="button" className="btn ghost" onClick={() => setAsking(false)}>{WIDGET_TOKEN_TEXTS.cancel}</button>
          </div>
        </div>
      )}
      <div className="settings-hint"><p>{note ?? WIDGET_TOKEN_TEXTS.hint}</p></div>
    </>
  );
}
