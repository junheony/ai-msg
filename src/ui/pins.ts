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
