import { lp, timingSafeEqual, toB64u } from '../../../src/shared/cloud/b64';

async function mac(secret: string, userId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toB64u(new Uint8Array(await crypto.subtle.sign('HMAC', key, lp('aimsg-userref-v1', userId) as BufferSource)));
}

/**
 * The checkout's `customData.ref`: `v1.<userId>.<b64u(HMAC-SHA256(CHECKOUT_SECRET, lp('aimsg-userref-v1', userId)))>`.
 * The browser hands it to Paddle, so only this server-signed value names the user — never a plain `user_id`.
 */
export async function signUserRef(secret: string, userId: string): Promise<string> {
  return `v1.${userId}.${await mac(secret, userId)}`;
}

/** The user id when `ref` has the right shape and MAC (constant-time compare), else `null`. */
export async function verifyUserRef(secret: string, ref: unknown): Promise<string | null> {
  if (typeof ref !== 'string' || ref.length > 512 || !ref.startsWith('v1.') || !secret) return null;
  const dot = ref.lastIndexOf('.');
  const userId = ref.slice(3, dot);
  if (dot <= 3 || userId.length === 0) return null;
  return timingSafeEqual(ref.slice(dot + 1), await mac(secret, userId)) ? userId : null;
}
