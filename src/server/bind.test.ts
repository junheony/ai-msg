import { describe, expect, it } from 'vitest';
import type os from 'node:os';
import { bindAddresses, isCgnat } from './bind';

function v4(address: string, internal = false): os.NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.255', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${address}/32` };
}

describe('isCgnat', () => {
  it('matches 100.64.0.0/10 only', () => {
    expect(isCgnat('100.64.0.0')).toBe(true);
    expect(isCgnat('100.106.182.94')).toBe(true);
    expect(isCgnat('100.127.255.255')).toBe(true);
    expect(isCgnat('100.128.0.0')).toBe(false);
    expect(isCgnat('100.63.255.255')).toBe(false);
    expect(isCgnat('192.168.1.2')).toBe(false);
    expect(isCgnat('not-an-ip')).toBe(false);
  });
});

describe('bindAddresses', () => {
  it('returns loopback plus tailscale addresses and nothing else', () => {
    const ifaces = {
      lo0: [v4('127.0.0.1', true)],
      en0: [v4('192.168.0.10')],
      utun4: [v4('100.106.182.94')],
      utun5: [{ ...v4('fd7a::1'), family: 'IPv6' as const }],
    };
    expect(bindAddresses(ifaces)).toEqual(['127.0.0.1', '100.106.182.94']);
  });

  it('returns only loopback when no tailscale interface exists or loopbackOnly is set', () => {
    expect(bindAddresses({ en0: [v4('192.168.0.10')] })).toEqual(['127.0.0.1']);
    expect(bindAddresses({ utun4: [v4('100.106.182.94')] }, { loopbackOnly: true })).toEqual(['127.0.0.1']);
  });
});
