import type os from 'node:os';

/** 100.64.0.0/10 — the CGNAT range Tailscale assigns. */
export function isCgnat(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}

/** Spec §6: bind 127.0.0.1 and Tailscale addresses only. Never 0.0.0.0. */
export function bindAddresses(
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
  opts: { loopbackOnly?: boolean } = {},
): string[] {
  const out = ['127.0.0.1'];
  if (opts.loopbackOnly) return out;
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal && isCgnat(info.address) && !out.includes(info.address)) {
        out.push(info.address);
      }
    }
  }
  return out;
}
