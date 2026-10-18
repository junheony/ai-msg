import { spawn, type ChildProcess } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpAbortError, AcpClosedError, AcpConnection, AcpRpcError, AcpTimeoutError, INTERNAL_ERROR, METHOD_NOT_FOUND } from './AcpConnection';

// A tiny line-echo agent: each JSON request becomes a response or a scripted behaviour; written inline (synthetic).
const AGENT = String.raw`
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
let buf = '';
const pending = new Map();
let n = 500;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.method === undefined) { const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); } continue; }
    switch (m.method) {
      case 'echo': send({ id: m.id, result: m.params }); break;
      case 'late': setTimeout(() => send({ id: m.id, result: 'late' }), m.params.ms); break;
      case 'boom': send({ id: m.id, error: { code: -32000, message: 'Authentication required', data: 'no auth method id provided' } }); break;
      case 'banner': process.stdout.write('not json at all\n{"half":\n'); send({ id: m.id, result: 'after' }); break;
      case 'huge': process.stdout.write('x'.repeat(m.params.bytes)); break;
      case 'notify-me': send({ method: 'ping', params: { k: m.params.k } }); send({ id: m.id, result: true }); break;
      case 'ask': {
        // Ask the client something, then keep talking while it waits: notifications must still arrive.
        const id = n++;
        send({ id, method: m.params.method, params: {} });
        pending.set(id, (resp) => send({ id: m.id, result: resp }));
        if (m.params.tick) setTimeout(() => send({ method: 'tick', params: { during: true } }), 30);
        break;
      }
      case 'exit': process.exit(0);
      case 'record': break;
      default: send({ id: m.id, error: { code: -32601, message: 'nope' } });
    }
  }
});
`;

const children: ChildProcess[] = [];
afterEach(() => { for (const c of children.splice(0)) c.kill('SIGKILL'); });

function agent(): { conn: AcpConnection; child: ChildProcess } {
  const child = spawn(process.execPath, ['-e', AGENT], { stdio: ['pipe', 'pipe', 'inherit'] });
  children.push(child);
  return { conn: new AcpConnection(child.stdout!, child.stdin!), child };
}

describe('AcpConnection', () => {
  it('pairs responses with requests by id, out of order', async () => {
    const { conn } = agent();
    const slow = conn.request('late', { ms: 80 });
    const fast = conn.request('echo', { a: 1 });
    expect(await fast).toEqual({ a: 1 });
    expect(await slow).toBe('late');
  });

  it('a JSON-RPC error rejects with AcpRpcError carrying code, message and data', async () => {
    const { conn } = agent();
    const e = await conn.request('boom', {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AcpRpcError);
    expect(e).toMatchObject({ code: -32000, message: 'Authentication required', data: 'no auth method id provided' });
  });

  it('notifications reach every handler; notify() sends a message without an id', async () => {
    const { conn } = agent();
    const got: unknown[] = [];
    conn.onNotification((method, params) => got.push([method, params]));
    await conn.request('notify-me', { k: 7 });
    expect(got).toEqual([['ping', { k: 7 }]]);
    await expect(conn.notify('record', { x: 1 })).resolves.toBeUndefined();
  });

  it('per-request time limit rejects with AcpTimeoutError; the late response is dropped', async () => {
    const { conn } = agent();
    const e = await conn.request('late', { ms: 200 }, 40).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AcpTimeoutError);
    await new Promise((r) => setTimeout(r, 250));
    expect(await conn.request('echo', 1)).toBe(1);
  });

  it('a signal aborts one waiting request only', async () => {
    const { conn } = agent();
    const ac = new AbortController();
    const p = conn.request('late', { ms: 200 }, undefined, ac.signal);
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AcpAbortError);
    expect(await conn.request('echo', 'ok')).toBe('ok');
  });

  it('agent requests: unknown methods get -32601; a waiting handler does not block other messages', async () => {
    const { conn } = agent();
    const unknown = (await conn.request('ask', { method: 'fs/read_text_file' })) as { error: { code: number } };
    expect(unknown.error.code).toBe(METHOD_NOT_FOUND);

    const ticks: unknown[] = [];
    conn.onNotification((m, p) => { if (m === 'tick') ticks.push(p); });
    let release!: (v: unknown) => void;
    conn.onRequest('session/request_permission', () => new Promise((r) => { release = r; }));
    const asked = conn.request('ask', { method: 'session/request_permission', tick: true });
    asked.catch(() => {});
    // While the handler waits, the read loop still delivers a notification and serves another response.
    await vi.waitFor(() => expect(ticks).toEqual([{ during: true }]), { timeout: 2000, interval: 10 });
    expect(await conn.request('echo', 'meanwhile')).toBe('meanwhile');
    release({ outcome: { outcome: 'cancelled' } });
    expect(await asked).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } });
  });

  it('skips non-JSON lines and counts them', async () => {
    const { conn } = agent();
    expect(await conn.request('banner', {})).toBe('after');
    expect(conn.skippedLines).toBe(2);
  });

  it('a line over the cap is a connection error that rejects every waiting request', async () => {
    const child = spawn(process.execPath, ['-e', AGENT], { stdio: ['pipe', 'pipe', 'inherit'] });
    children.push(child);
    const conn = new AcpConnection(child.stdout!, child.stdin!, { maxLineBytes: 64 * 1024 });
    const waiting = conn.request('late', { ms: 5000 });
    void conn.request('huge', { bytes: 200 * 1024 }).catch(() => {});
    const e = await waiting.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AcpClosedError);
    expect((e as Error).message).toMatch(/exceeds/);
    expect(conn.isClosed).toBe(true);
  });

  it('the default cap is 8MB: 9MB without a newline closes the connection', async () => {
    const { conn } = agent();
    const waiting = conn.request('late', { ms: 10_000 });
    void conn.request('huge', { bytes: 9 * 1024 * 1024 }).catch(() => {});
    await expect(waiting).rejects.toThrow(/exceeds 8388608 bytes/);
  });

  it('agent exit rejects waiting requests; later requests fail at once; an in-flight handler answer is not sent', async () => {
    const { conn, child } = agent();
    let release!: (v: unknown) => void;
    conn.onRequest('session/request_permission', () => new Promise((r) => { release = r; }));
    void conn.request('ask', { method: 'session/request_permission' }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    const waiting = conn.request('late', { ms: 5000 });
    void conn.request('exit', {}).catch(() => {});
    await expect(waiting).rejects.toBeInstanceOf(AcpClosedError);
    expect(await conn.closed).toBeInstanceOf(AcpClosedError);
    await expect(conn.request('echo', 1)).rejects.toBeInstanceOf(AcpClosedError);
    const writes: string[] = [];
    const stdin = child.stdin!;
    stdin.write = ((s: string) => { writes.push(s); return true; }) as typeof stdin.write;
    release({ outcome: { outcome: 'cancelled' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(writes).toEqual([]);
  });

  it('waits for drain when the pipe is full (backpressure) and keeps lines in order', async () => {
    const lines: string[] = [];
    const callbacks: Array<() => void> = [];
    const out = new Writable({ highWaterMark: 1, write(chunk, _enc, cb) { lines.push(String(chunk)); callbacks.push(cb); } });
    const input = new PassThrough();
    const conn = new AcpConnection(input, out);
    const a = conn.notify('a', {});
    const b = conn.notify('b', {});
    let aDone = false;
    void a.then(() => { aDone = true; });
    await new Promise((r) => setTimeout(r, 20));
    // `a` is written but the buffer is over its mark: neither resolves and `b` is not written until drain.
    expect(aDone).toBe(false);
    expect(lines).toHaveLength(1);
    callbacks.shift()!();
    await a;
    await new Promise((r) => setTimeout(r, 0));
    expect(lines).toHaveLength(2);
    callbacks.shift()!();
    await b;
    expect(lines.map((l) => JSON.parse(l).method)).toEqual(['a', 'b']);
  });

  it('a handler that throws (async or not) answers -32603 with its message; a thrown AcpRpcError keeps its code', async () => {
    const { conn } = agent();
    conn.onRequest('async/boom', async () => { throw new Error('kaboom'); });
    conn.onRequest('sync/boom', () => { throw new Error('sync kaboom'); });
    conn.onRequest('rpc/boom', async () => { throw new AcpRpcError(-32002, 'not here'); });
    expect(await conn.request('ask', { method: 'async/boom' })).toMatchObject({ error: { code: INTERNAL_ERROR, message: 'kaboom' } });
    expect(await conn.request('ask', { method: 'sync/boom' })).toMatchObject({ error: { code: INTERNAL_ERROR, message: 'sync kaboom' } });
    expect(await conn.request('ask', { method: 'rpc/boom' })).toMatchObject({ error: { code: -32002, message: 'not here' } });
  });

  it('a multi-byte UTF-8 character cut across chunks arrives whole', async () => {
    const input = new PassThrough();
    const out = new Writable({ write(_c, _e, cb) { cb(); } });
    const conn = new AcpConnection(input, out);
    const got: unknown[] = [];
    conn.onNotification((_m, p) => got.push(p));
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'n', params: { t: '한글 🙂 é' } }) + '\n', 'utf8');
    // Cut inside every multi-byte sequence: each byte its own chunk.
    for (let i = 0; i < bytes.length; i++) input.write(bytes.subarray(i, i + 1));
    await vi.waitFor(() => expect(got).toEqual([{ t: '한글 🙂 é' }]), { timeout: 1000, interval: 5 });
    const p = conn.request('x', {});
    const reply = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '日本' }) + '\n', 'utf8');
    const cut = reply.indexOf(Buffer.from('日', 'utf8')) + 1;
    input.write(reply.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 10));
    input.write(reply.subarray(cut));
    expect(await p).toBe('日本');
  });
});
