import { useEffect, useRef, useState, type ReactNode } from 'react';
import { takeSse } from '../authSse';
import { Sheet, SheetHead } from './Dialogs';

type Phase = 'starting' | 'open' | 'done' | 'error';

/** URLs in the login output become links so a phone can open them. Trailing punctuation stays outside the link. */
export function linkify(text: string): ReactNode[] {
  const re = /https?:\/\/[^\s<>"']+/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) nodes.push(text.slice(last, i));
    let url = m[0];
    let trail = '';
    while (url.length > 0 && /[),.;:]$/.test(url)) { trail = url.slice(-1) + trail; url = url.slice(0, -1); }
    nodes.push(<a key={i} href={url} target="_blank" rel="noreferrer">{url}</a>);
    if (trail) nodes.push(trail);
    last = i + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/**
 * A small window that runs one allowlisted login (`claude auth login`, `codex login`, `grok login --device-auth`,
 * or `agy` for one Gemini seat). The only thing that can be sent is a pasted code or Enter. There is no shell.
 */
export function AuthTerminal({ seat, title, onClose, onLoggedIn, fetchFn = fetch }: {
  seat: string;
  title: string;
  onClose: () => void;
  /** The login command exited 0. The caller refreshes the login probe. */
  onLoggedIn?: () => void;
  fetchFn?: typeof fetch;
}) {
  const [phase, setPhase] = useState<Phase>('starting');
  const [label, setLabel] = useState('');
  const [out, setOut] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const idRef = useRef<string | null>(null);
  const outRef = useRef<HTMLPreElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onLoggedInRef = useRef(onLoggedIn);
  onLoggedInRef.current = onLoggedIn;

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    // Cancel must not use the stream's abort signal: cleanup aborts that signal first, and a cancelled fetch never reaches the server.
    const stop = (id: string | null) => { if (id) void fetchFn(`/api/auth-login/${id}/cancel`, { method: 'POST' }).catch(() => {}); };
    void (async () => {
      let id: string | null = null;
      try {
        const started = await fetchFn('/api/auth-login', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seat }), signal: ac.signal,
        });
        const body = await started.json() as { id?: string; label?: string; error?: string };
        if (!started.ok || !body.id) { if (!cancelled) { setError(body.error ?? '로그인 창을 열지 못했습니다'); setPhase('error'); } return; }
        id = body.id;
        idRef.current = id;
        if (cancelled) { stop(id); return; }
        setLabel(body.label ?? '');
        setPhase('open');
        const stream = await fetchFn(`/api/auth-login/${id}/stream`, { signal: ac.signal });
        if (!stream.ok || !stream.body) { if (!cancelled) { setError('출력을 받지 못했습니다'); setPhase('error'); } return; }
        const reader = stream.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const step = await reader.read();
          if (step.done || cancelled) break;
          buf += dec.decode(step.value, { stream: true });
          const parsed = takeSse(buf);
          buf = parsed.rest;
          for (const ev of parsed.events) {
            if (ev.event === 'out') {
              const text = (JSON.parse(ev.data) as { text?: string }).text ?? '';
              setOut((prev) => (prev + text).slice(-16_000));
            } else if (ev.event === 'error') {
              setError((JSON.parse(ev.data) as { message?: string }).message ?? '로그인 창이 닫혔습니다');
            } else if (ev.event === 'exit') {
              const exitCode = (JSON.parse(ev.data) as { code?: number | null }).code;
              if (exitCode === 0) { setPhase('done'); onLoggedInRef.current?.(); }
              else if (!cancelled) setPhase((p) => (p === 'done' ? p : 'error'));
            }
          }
        }
      } catch {
        if (!cancelled) setPhase((p) => (p === 'done' ? p : 'error'));
      }
    })();
    return () => { cancelled = true; ac.abort(); stop(idRef.current); };
  }, [seat, fetchFn]);

  useEffect(() => { if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight; }, [out]);

  const menuSent = useRef(false);
  useEffect(() => {
    if (menuSent.current || phase !== 'open' || !idRef.current) return;
    if (!/Select login method/.test(out)) return;
    menuSent.current = true;
    void fetchFn(`/api/auth-login/${idRef.current}/input`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enter: true }),
    }).catch(() => {});
  }, [out, phase, fetchFn]);

  const note = seat === 'g1' || seat === 'g2'
    ? '이 창은 그 자리의 agy 만 실행합니다. Enter 가 Google 로그인을 고릅니다. 한 줄로 나온 주소를 열어 로그인하고, 브라우저가 준 코드를 붙여 넣으세요.'
    : seat === 'x1'
      ? '이 창은 grok login --device-auth 만 실행합니다. 나온 주소와 코드를 다른 기기에서 입력하고, 이 창은 로그인이 끝날 때까지 열어 두세요.'
      : '이 창은 로그인 명령만 실행합니다. 다른 명령은 입력할 수 없습니다. 주소가 나오면 눌러 로그인하고, 받은 코드를 아래에 붙여 넣으세요.';

  const send = async (body: { text?: string; enter?: boolean }) => {
    const id = idRef.current;
    if (!id || sending || phase !== 'open') return;
    setSending(true);
    try {
      const r = await fetchFn(`/api/auth-login/${id}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) {
        const j = await r.json().catch(() => ({})) as { error?: string };
        setError(j.error ?? '보내지 못했습니다');
      } else if (body.text) setCode('');
    } catch { setError('보내지 못했습니다'); }
    finally { setSending(false); }
  };

  return (
    <Sheet className="auth-term-sheet" label={`${title} 다시 로그인`} onClose={onClose}>
      <div className="auth-term">
        <SheetHead title={`${title} 다시 로그인`} onClose={onClose} autoFocus={false} />
        <p className="auth-note">{note}</p>
        {label && <p className="auth-note"><code>{label}</code></p>}
        <pre ref={outRef} className="auth-term-out" role="log" aria-live="polite" data-testid="auth-out">{out ? linkify(out) : (phase === 'starting' ? '여는 중…' : '')}</pre>
        {error && <p className="auth-note update-error" role="alert">{error}</p>}
        {phase === 'done' && <p className="auth-note" role="status">로그인됐습니다.</p>}
        {phase === 'open' && (
          <form className="auth-term-row" onSubmit={(e) => { e.preventDefault(); void send({ text: code }); }}>
            <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="코드 붙여넣기" aria-label="로그인 코드" data-testid="auth-code" />
            <button type="submit" className="btn primary" disabled={sending || !code.trim()}>보내기</button>
            <button type="button" className="btn ghost" disabled={sending} onClick={() => void send({ enter: true })}>Enter</button>
          </form>
        )}
        {phase !== 'open' && phase !== 'starting' && <button type="button" className="btn" onClick={onClose}>닫기</button>}
      </div>
    </Sheet>
  );
}
