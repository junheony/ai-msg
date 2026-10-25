import { afterEach, describe, expect, it, vi } from 'vitest';
import roomSrc from '../src/relay/RelayRoom.ts?raw';
import routesSrc from '../src/relay/routes.ts?raw';
import ticketsSrc from '../src/relay/tickets.ts?raw';
import type { PairClaimRes, TicketRes } from '../../src/shared/cloud/api-types';
import { EnvKind, encodeEnvelope } from '../../src/shared/cloud/envelope';
import { RELAY, bearer, call, claim, linkHost, post, relayPost } from './helpers';

const relaySources = { 'RelayRoom.ts': roomSrc, 'routes.ts': routesSrc, 'tickets.ts': ticketsSrc };
const importsOf = (src: string) => [...src.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);

describe('RelayRoom stays asleep (no resident timers)', () => {
  it('RelayRoom keeps no resident timers', () => {
    expect(roomSrc).not.toMatch(/setInterval|setTimeout/);
    expect(roomSrc).toMatch(/setWebSocketAutoResponse/);
    expect(roomSrc).toMatch(/acceptWebSocket/);
    expect(roomSrc).not.toMatch(/webSocketError/); // (미확인) — errors are left to converge on close
  });
});

describe('the cloud never sees plaintext', () => {
  it('relay code imports only the envelope from the shared protocol — no frames, noise, pairing or zod', () => {
    for (const [name, src] of Object.entries(relaySources)) {
      for (const spec of importsOf(src)) {
        if (spec.includes('src/shared/')) expect(spec, name).toMatch(/\/src\/shared\/cloud\/(envelope|b64|api-types)$/);
        expect(spec, name).not.toMatch(/frames|noise|pairing|zod/);
      }
    }
    expect(importsOf(roomSrc).filter((s) => s.includes('src/shared/'))).toEqual(['../../../src/shared/cloud/envelope']);
  });

  it('the DO reads only the envelope head: it never decodes, parses or touches the payload by name', () => {
    expect(roomSrc).toMatch(/decodeEnvelope/);
    expect(roomSrc).not.toMatch(/\.payload\b/); // forwarded by spreading the decoded envelope, never read
    for (const [name, src] of Object.entries(relaySources)) {
      expect(src, name).not.toMatch(/TextDecoder|decrypt|subtle\.|atob\(|fromB64/);
    }
    // JSON.parse only ever sees text control messages, never a binary frame.
    const parses = [...roomSrc.matchAll(/JSON\.parse\(([^)]*)\)/g)].map((m) => m[1]);
    expect(parses).toEqual(['text']);
  });

  it('the Worker routes never read WebSocket traffic; they only hand the upgrade to the DO', () => {
    expect(routesSrc).not.toMatch(/addEventListener|\.accept\(|WebSocketPair/);
    expect(ticketsSrc).not.toMatch(/addEventListener|WebSocketPair/);
  });

  it('every log line is one JSON object of metadata only (ev, host, dev, bytes, code)', () => {
    for (const [name, src] of Object.entries(relaySources)) {
      const calls = [...src.matchAll(/console\.(\w+)\(([^;]*)\);/g)].map((m) => `${m[1]}(${m[2]})`);
      for (const c of calls) expect(c, name).toBe('log(JSON.stringify({ ev, host, dev, bytes, code }))');
    }
  });
});

describe('the cloud never logs plaintext (runtime)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('a relayed session leaves only metadata in the logs', async () => {
    const lines: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });

    const h = await linkHost('static@example.test');
    const c = await claim({ hostToken: h.hostToken });
    const dev = (await c.res.json()) as PairClaimRes;
    await post(`/v1/pair/${c.pairingId}/confirm`, {}, bearer(h.hostToken));
    const ticket = ((await (await relayPost('/v1/relay/ticket', {}, bearer(dev.deviceToken))).json()) as TicketRes).ticket;

    const open = async (path: string, headers: Record<string, string>) => {
      const res = await call(path, { headers: { upgrade: 'websocket', ...headers } }, RELAY);
      const ws = res.webSocket!;
      ws.binaryType = 'arraybuffer';
      ws.accept();
      const got: unknown[] = [];
      ws.addEventListener('message', (e) => got.push(e.data));
      return { ws, got };
    };
    const host = await open('/relay/host', bearer(h.hostToken));
    const phone = await open(`/relay/device?ticket=${ticket}`, { origin: RELAY });

    const SECRET = 'PLAINTEXT-MARKER-do-not-log';
    const frame = new TextEncoder().encode(JSON.stringify({ t: 'http.req', id: 1, m: 'POST', p: '/api/send', h: {}, b: btoa(SECRET), more: false, note: SECRET }));
    phone.ws.send(encodeEnvelope({ kind: EnvKind.Data, peer: 'host', payload: frame }));
    host.ws.send(encodeEnvelope({ kind: EnvKind.Data, peer: dev.deviceId, payload: frame }));
    host.ws.send(new Uint8Array([200, 1, 2, 3])); // malformed: dropped, maybe logged by size
    const end = Date.now() + 3000;
    while ((!host.got.some((m) => m instanceof ArrayBuffer) || !phone.got.some((m) => m instanceof ArrayBuffer)) && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    expect(host.got.some((m) => m instanceof ArrayBuffer) && phone.got.some((m) => m instanceof ArrayBuffer)).toBe(true); // the frames really went through
    await post(`/v1/devices/${dev.deviceId}/revoke`, {}, bearer(h.hostToken));
    await post('/v1/host/unlink', {}, bearer(h.hostToken));
    await new Promise((r) => setTimeout(r, 200));

    const relayLines = lines.filter((l) => l.startsWith('{"ev":'));
    expect(relayLines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).not.toContain(SECRET);
      expect(l).not.toContain(btoa(SECRET));
      expect(l).not.toContain(dev.deviceToken);
      expect(l).not.toContain(h.hostToken);
      expect(l).not.toContain(ticket);
    }
    for (const l of relayLines) {
      const o = JSON.parse(l) as Record<string, unknown>;
      for (const k of Object.keys(o)) expect(['ev', 'host', 'dev', 'bytes', 'code']).toContain(k);
      for (const v of Object.values(o)) expect(['string', 'number']).toContain(typeof v);
    }
  });
});
