import { useState, type FormEvent } from 'react';
import { BrandMark, BrandWordmark } from './BrandMark';
import { ui } from '../i18n';

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const T = ui().login;
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    if (res.ok) onLoggedIn();
    else setErr(T.badToken);
  };
  return (
    <form className="login" onSubmit={submit}>
      <h1><BrandMark className="login-mark" /><BrandWordmark /></h1>
      <p>{T.hint}</p>
      {/* The only place with a path/command; `…` in it is a command: shown as code. */}
      <details className="login-where">
        <summary>{T.where}</summary>
        <p>{T.whereBody.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</p>
      </details>
      <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={T.token} autoFocus />
      <button type="submit" className="btn primary">{T.submit}</button>
      {err && <div className="error">{err}</div>}
    </form>
  );
}
