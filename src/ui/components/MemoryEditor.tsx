import { useEffect, useState } from 'react';
import { MEMORY_MAX_BYTES, memoryBytes } from '../../shared/memory';

type Load = { state: 'loading' } | { state: 'off' } | { state: 'ready'; saved: string; max: number };

/**
 * Settings → 일반 · deck 메모: one note every model sees each turn (server `memory.md`, /api/memory). Hidden when the
 * server has no memory store (an older server answers 404).
 */
export function MemoryEditor({ fetchFn = fetch }: { fetchFn?: typeof fetch }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetchFn('/api/memory', { credentials: 'same-origin' });
        if (!res.ok) { if (live) setLoad({ state: 'off' }); return; }
        const body = (await res.json()) as { text?: unknown; max?: unknown };
        const text = typeof body.text === 'string' ? body.text : '';
        if (!live) return;
        setLoad({ state: 'ready', saved: text, max: typeof body.max === 'number' ? body.max : MEMORY_MAX_BYTES });
        setDraft(text);
      } catch {
        if (live) setLoad({ state: 'off' });
      }
    })();
    return () => { live = false; };
  }, [fetchFn]);

  if (load.state !== 'ready') return null;
  const bytes = memoryBytes(draft);
  const over = bytes > load.max;
  const dirty = draft.trim() !== load.saved.trim();

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetchFn('/api/memory', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: draft }) });
      const body = (await res.json().catch(() => ({}))) as { text?: unknown; error?: unknown };
      if (!res.ok) { setStatus(typeof body.error === 'string' ? body.error : `저장 실패 (${res.status})`); return; }
      const text = typeof body.text === 'string' ? body.text : draft;
      setLoad({ ...load, saved: text });
      setDraft(text);
      setStatus('저장했습니다');
    } catch {
      setStatus('저장 실패: 네트워크 오류');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="memory-editor" data-testid="memory-editor">
      <label htmlFor="deck-memory"><span>Crew 메모</span></label>
      <p className="settings-hint" id="deck-memory-hint">모든 엔진(Claude·GPT·Gemini·Grok)이 매 턴 참고하는 메모입니다. 대화 기록에는 남지 않고, 이 서버의 모든 기기가 같이 씁니다.</p>
      <textarea id="deck-memory" aria-describedby="deck-memory-hint" data-testid="memory-text" rows={6} value={draft} placeholder="예: 답은 한국어로. 회사 저장소는 ~/work 아래에 있음. 배포는 금요일에 하지 않음." onChange={(e) => { setDraft(e.target.value); setStatus(null); }} />
      <div className="memory-foot">
        <span className={over ? 'memory-count over' : 'memory-count'} data-testid="memory-count">{bytes} / {load.max}바이트</span>
        {status && <span className="memory-status" role="status">{status}</span>}
        <button type="button" className="btn" data-testid="memory-save" disabled={!dirty || over || saving} onClick={() => { void save(); }}>{saving ? '저장 중…' : '저장'}</button>
      </div>
    </div>
  );
}
