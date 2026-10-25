import { describe, expect, it } from 'vitest';
import { emailKey, normalizeEmail } from '../src/auth/email';

describe('email normalization (trial key only)', () => {
  it('normalizes plus tags, gmail dots and googlemail', () => {
    expect(normalizeEmail(' A.B+promo@GoogleMail.com ')).toBe('ab@gmail.com');
    expect(normalizeEmail('a.b+x@example.test')).toBe('a.b@example.test');
    expect(normalizeEmail('no-at-sign')).toBeNull();
    expect(normalizeEmail('a@b@example.test')).toBeNull();
    expect(normalizeEmail(`${'a'.repeat(250)}@x.test`)).toBeNull();
    expect(normalizeEmail('@example.test')).toBeNull();
  });

  it('emailKey is a keyed hash of the normalized address', async () => {
    const k = await emailKey('e'.repeat(32), 'T.R.I.A.L@gmail.com');
    expect(k).toBe(await emailKey('e'.repeat(32), 'trial+x@googlemail.com'));
    expect(k).not.toBe(await emailKey('f'.repeat(32), 'trial@gmail.com'));
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
