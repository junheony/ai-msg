/**
 * The page's `location.hash`, live. The Trading room's only interactions are links, and a link that changes the hash
 * is how a symbol or the full symbol list is chosen — nothing is posted, nothing is stored.
 */
import { useEffect, useState } from 'react';

const read = (): string => (typeof window === 'undefined' ? '' : window.location.hash);

export function useHash(): string {
  const [hash, setHash] = useState(read);
  useEffect(() => {
    const on = () => setHash(read());
    on();
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

/** `#sr=BTCUSDT` → BTCUSDT (upper-cased, validated by the caller); any other hash → null. */
export function hashSymbol(hash: string): string | null {
  const m = /^#sr=([A-Za-z0-9]{3,20})$/.exec(hash);
  return m ? m[1]!.toUpperCase() : null;
}
