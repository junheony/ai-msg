import { ui } from './i18n';

/** F2: toggles a session pin on the server (which broadcasts the new list to every device); returns the pins. */
export async function postPin(sessionId: string, pinned: boolean, fetchFn: typeof fetch = fetch): Promise<string[]> {
  let res: Response;
  try {
    res = await fetchFn('/api/pins', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, pinned }) });
  } catch {
    throw new Error('고정 실패: 네트워크 오류');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `고정 실패 (${res.status})`);
  }
  return ((await res.json()) as { pins: string[] }).pins;
}

/** 고정됨 drag order: sends the full list (top first); the server persists and broadcasts it, and returns the pins. */
export async function postPinOrder(order: string[], fetchFn: typeof fetch = fetch): Promise<string[]> {
  let res: Response;
  try {
    res = await fetchFn('/api/pins/order', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order }) });
  } catch {
    throw new Error('고정 순서 변경 실패: 네트워크 오류');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `고정 순서 변경 실패 (${res.status})`);
  }
  return ((await res.json()) as { pins: string[] }).pins;
}

/** 직접 고르기: sets a session's avatar icon (null = back to the first letter); the server broadcasts it, returns the whole map. */
export async function postSessionIcon(sessionId: string, icon: string | null, fetchFn: typeof fetch = fetch): Promise<Record<string, string>> {
  const t = ui().sessionIcon;
  let res: Response;
  try {
    res = await fetchFn('/api/session-icon', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, icon }) });
  } catch {
    throw new Error(t.network);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${t.failed} (${res.status})`);
  }
  return ((await res.json()) as { sessionIcons: Record<string, string> }).sessionIcons;
}
