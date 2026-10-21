/**
 * The token from a login address (`quarterdeck login-url` prints `http://…/#token=<encoded>`): decoded, or null when
 * the hash has none, an empty one or one that does not decode. A `+` stays a `+` (decodeURIComponent, not form decoding).
 */
export function readHashToken(hash: string): string | null {
  for (const part of hash.replace(/^#/, '').split('&')) {
    if (!part.startsWith('token=')) continue;
    try {
      const value = decodeURIComponent(part.slice('token='.length));
      return value || null;
    } catch {
      return null;
    }
  }
  return null;
}
