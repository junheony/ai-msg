import { describe, expect, it } from 'vitest';
import { clientIp, ipKey } from '../src/http';

describe('ipKey (per-IP limit key)', () => {
  it('keeps IPv4 as is', () => {
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('groups IPv6 by /64 and normalizes the written form', () => {
    const k = ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    expect(k).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:DB8:1:2::1')).toBe(k);
    expect(ipKey('2001:0db8:0001:0002:0:0:0:ffff')).toBe(k);
    expect(ipKey('2001:db8:1:3::1')).not.toBe(k);
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipKey('::1')).toBe('0:0:0:0::/64');
    expect(ipKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('treats IPv4-mapped IPv6 as the IPv4 address', () => {
    expect(ipKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('does not crash on junk', () => {
    expect(ipKey('')).toBe('unknown');
    expect(ipKey('1:2:3')).toBe('unknown');
    expect(ipKey('1::2::3')).toBe('unknown');
    expect(ipKey('zzzz::1')).toBe('unknown');
  });

  it('clientIp reads cf-connecting-ip through ipKey', () => {
    expect(clientIp(new Request('https://app.test/', { headers: { 'cf-connecting-ip': '2001:db8:1:2::9' } }))).toBe('2001:db8:1:2::/64');
    expect(clientIp(new Request('https://app.test/'))).toBe('unknown');
  });
});
