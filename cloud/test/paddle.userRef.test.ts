import { describe, expect, it } from 'vitest';
import { signUserRef, verifyUserRef } from '../src/paddle/userRef';

describe('userRef', () => {
  it('round-trips and rejects tampering', async () => {
    const ref = await signUserRef('c'.repeat(32), 'u_1');
    expect(ref.startsWith('v1.u_1.')).toBe(true);
    expect(await verifyUserRef('c'.repeat(32), ref)).toBe('u_1');
    expect(await verifyUserRef('c'.repeat(32), ref.replace('u_1', 'u_2'))).toBeNull();
    expect(await verifyUserRef('c'.repeat(32), 'u_1')).toBeNull();
    expect(await verifyUserRef('c'.repeat(32), { user_id: 'u_1' })).toBeNull();
    expect(await verifyUserRef('d'.repeat(32), ref)).toBeNull();
    expect(await verifyUserRef('c'.repeat(32), ref.replace('v1.', 'v2.'))).toBeNull();
    expect(await verifyUserRef('c'.repeat(32), undefined)).toBeNull();
  });
});
