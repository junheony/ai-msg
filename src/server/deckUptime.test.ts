import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../../scripts/monitor/deck-uptime.sh');

/** A stand-in deck (answers /api/me with `status`, or refuses connections when `up` is false) and a control site that is always up. */
let status = 401;
let dir = '';
let deck: http.Server;
let control: http.Server;
let deckPort = 0;
let controlPort = 0;

const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));
const closed = (s: http.Server) => new Promise<void>((r) => s.close(() => r()));

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-uptime-'));
  deck = http.createServer((_req, res) => { res.writeHead(status); res.end(); });
  control = http.createServer((_req, res) => { res.writeHead(204); res.end(); });
  deckPort = await listen(deck);
  controlPort = await listen(control);
});
afterAll(async () => { await closed(control); if (deck.listening) await closed(deck); });

function run(env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; err: string }>((resolve) => {
    const p = spawn('/bin/bash', [SCRIPT], { env: { ...process.env, DECK_UPTIME_DIR: dir, DECK_UPTIME_URL: `http://127.0.0.1:${deckPort}/`, DECK_UPTIME_CONTROLS: `http://127.0.0.1:${controlPort}/`, DECK_UPTIME_RETRY_SLEEP: '0', DECK_UPTIME_NOTIFY_FILE: path.join(dir, 'sent'), ...env } });
    let err = '';
    p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('close', (code) => resolve({ code, err }));
  });
}
const sent = async () => { try { return (await fs.readFile(path.join(dir, 'sent'), 'utf8')).trim().split('\n').filter(Boolean); } catch { return []; } };
const log = async () => fs.readFile(path.join(dir, 'uptime.log'), 'utf8').catch(() => '');

describe('scripts/monitor/deck-uptime.sh', () => {
  it('refuses to run without a URL', async () => {
    const r = await run({ DECK_UPTIME_URL: '' });
    expect(r.code).toBe(2);
    expect(r.err).toContain('DECK_UPTIME_URL');
  });

  it('401 from /api/me is "up"; two misses alert once; the return is announced once with the outage length', async () => {
    expect((await run()).code).toBe(0);
    expect(await sent()).toEqual([]);

    await closed(deck); // the server is gone: connection refused → HTTP 000, control still answers → a real failure
    expect((await run()).code).toBe(0);
    expect(await sent()).toEqual([]); // first miss: below the threshold
    expect(await log()).toMatch(/FAIL 1 \(HTTP 000\)/);
    await run();
    const alerts = await sent();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('🔴 Crew 서버 응답 없음');
    expect(alerts[0]).toContain('relaunch.sh status');
    await run();
    expect(await sent()).toHaveLength(1); // still down: no repeat

    deck = http.createServer((_req, res) => { res.writeHead(status); res.end(); });
    await new Promise<void>((r) => deck.listen(deckPort, '127.0.0.1', () => r()));
    await run();
    const after = await sent();
    expect(after).toHaveLength(2);
    expect(after[1]).toMatch(/🟢 Crew 복구 .* 0분 중단/);
    expect(await fs.readFile(path.join(dir, 'uptime.state'), 'utf8')).toBe('0 0 \n');
  }, 20_000);

  it('a 5xx from the server counts as a failure without consulting the controls', async () => {
    status = 503;
    await run();
    expect(await log()).toMatch(/FAIL 1 \(HTTP 503\)/);
    status = 401;
    await run();
    expect(await log()).toMatch(/OK again after 1 miss/);
  });

  it('no HTTP from deck nor from the controls = this box is blind: logged, nothing counted or sent', async () => {
    const before = (await sent()).length;
    await closed(deck);
    await run({ DECK_UPTIME_CONTROLS: 'http://127.0.0.1:9/' });
    expect(await log()).toMatch(/BLIND/);
    expect(await fs.readFile(path.join(dir, 'uptime.state'), 'utf8')).toBe('0 0 \n');
    expect((await sent()).length).toBe(before);
  });
});
