import type { SetupStatus } from '../shared/setup-types';
import { SETUP_TEXTS } from './setupTexts';

// The setup wizard's calls (/api/setup*, plan ② Task 5).

const post = (url: string, body: unknown = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function errorOf(r: Response): Promise<string> {
  const body = (await r.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === 'string' && body.error ? body.error : SETUP_TEXTS.requestFailed(r.status);
}

async function statusOf(r: Response): Promise<SetupStatus> {
  if (!r.ok) throw new Error(await errorOf(r));
  return (await r.json()) as SetupStatus;
}

/** The status (CLI probes cached 30 s on the server). */
export const getSetup = (): Promise<SetupStatus> => fetch('/api/setup').then(statusOf);
/** The status with fresh probes (다시 확인). */
export const refreshSetup = (): Promise<SetupStatus> => post('/api/setup/refresh').then(statusOf);

/** Register a Claude profile (applied at the next server start). The server's error text comes back as is. */
export async function addProfile(id: string, label?: string): Promise<{ ok: true; restartNeeded: true } | { ok: false; error: string }> {
  try {
    const r = await post('/api/setup/profiles', label !== undefined ? { id, label } : { id });
    return r.ok ? { ok: true, restartNeeded: true } : { ok: false, error: await errorOf(r) };
  } catch {
    return { ok: false, error: SETUP_TEXTS.unreachable };
  }
}

export async function markSetupDone(): Promise<void> {
  const r = await post('/api/setup/done');
  if (!r.ok) throw new Error(await errorOf(r));
}

/** POST /api/restart (graceful: the server waits for running turns). */
export async function restartServer(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const r = await post('/api/restart');
    return r.ok ? { ok: true } : { ok: false, error: await errorOf(r) };
  } catch {
    return { ok: false, error: SETUP_TEXTS.unreachable };
  }
}
