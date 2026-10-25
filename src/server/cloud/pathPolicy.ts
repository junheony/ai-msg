export type RelayPathVerdict = 'allow' | 'deny' | 'mac_confirm_required';

/** `.`/`..` segments resolved and runs of `/` collapsed, the way a URL parser or router might see the path. */
function normalise(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}${p.endsWith('/') && out.length > 0 ? '/' : ''}`;
}

const under = (p: string, base: string) => p === base || p.startsWith(`${base}/`);

/**
 * What a phone may ask of the Mac's HTTP API through the relay. The query is cut off, the path percent-decoded and
 * normalised, and the result must equal the path as sent: anything that does not decode, carries a percent-escape, or
 * that normalisation would change (dot segments, `//`) is `deny` — the frame schema's path check is only a first line.
 * The rules then match that one spelling, so `/api/%72estart` cannot slip past `/api/restart`.
 * `mac_confirm_required` = the security model's list of things only the Mac itself may do.
 */
export function relayPathPolicy(method: string, path: string): RelayPathVerdict {
  const raw = path.split(/[?#]/, 1)[0] ?? '';
  if (!raw.startsWith('/api/') || raw.includes('\\') || raw.includes('//') || /%2e%2e/i.test(raw)) return 'deny';
  let p: string;
  try { p = decodeURIComponent(raw); } catch { return 'deny'; }
  if (/[\x00-\x20\x7f]/.test(p) || normalise(p) !== raw) return 'deny';
  const m = method.toUpperCase();
  if (under(p, '/api/restart') || under(p, '/api/setup') || under(p, '/api/login') || under(p, '/api/logout')) return 'mac_confirm_required';
  if (p.startsWith('/api/server-update') && m !== 'GET') return 'mac_confirm_required';
  if (under(p, '/api/cloud')) return m === 'GET' && p === '/api/cloud/status' ? 'allow' : 'mac_confirm_required';
  return 'allow';
}
