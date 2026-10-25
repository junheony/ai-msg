import type { Env } from './env';

export type Mail = { to: string; subject: string; text: string };
export interface EmailSender { send(m: Mail): Promise<void> }

/** `log` writes to the `outbox` table (checkConfig allows it on local / `.test` origins only). */
export const logSender = (db: D1Database): EmailSender => ({
  async send(m) {
    await db.prepare('INSERT INTO outbox (to_addr, subject, body, created_at) VALUES (?, ?, ?, ?)').bind(m.to, m.subject, m.text, Date.now()).run();
  },
});

/** Resend `POST /emails` (`Authorization: Bearer`, `{from, to, subject, text}` — checked against the API reference, see README). */
export const resendSender = (apiKey: string, from: string, fetchFn: typeof fetch = fetch): EmailSender => ({
  async send(m) {
    const r = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: m.to, subject: m.subject, text: m.text }),
    });
    if (!r.ok) throw new Error(`resend ${r.status}`);
  },
});

export const emailSender = (env: Env): EmailSender =>
  env.EMAIL_MODE === 'log' ? logSender(env.DB) : resendSender(env.RESEND_API_KEY ?? '', env.EMAIL_FROM);
