import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GROKBOT_ID_PREFIX, GrokBotIndex, classifyBlob, decodeBlobKey, readBlob, readGrokBotTranscript, readGrokBotWeeklyUsage } from './GrokBotImports';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** RFC 4648 base32 (no padding) — the app's blob file names, built at runtime. */
function b32(s: string): string {
  let bits = 0;
  let val = 0;
  let out = '';
  for (const byte of Buffer.from(s, 'utf8')) {
    val = (val << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
const ACC = 'acct.user@example.test';
const key = (rest: string) => `sand.client.slice.account.${ACC}.${rest}`;
const blobName = (rest: string) => `${b32(key(rest))}.blob`;
const AGENT = '0123abcd-0000-4000-8000-00000000000a';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-grokbot-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }); });

const write = (name: string, body: unknown) => fs.writeFile(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
const roster = (rows: unknown[], schemaVersion = 4) => ({ schemaVersion, value: { rows } });
const row = (over: Record<string, unknown> = {}) => ({ id: AGENT, name: '여행 계획', description: '도쿄\n여행', lastEntry: { text: '다음 주 일정\n정리' }, lastActivityAt: 1_700_000_000_000, unreadCount: 2, isGroup: false, awaitingUserResponse: null, ...over });

describe('blob names', () => {
  it('decodes base32 keys and only classifies the three allowlisted kinds', () => {
    expect(decodeBlobKey(blobName('roster.last-roster'))).toBe(key('roster.last-roster'));
    expect(classifyBlob(blobName('roster.last-roster'))).toEqual({ kind: 'roster' });
    expect(classifyBlob(blobName(`transcript.replicas.${AGENT}`))).toEqual({ kind: 'transcript', agentId: AGENT });
    expect(classifyBlob(blobName('weekly-usage.cache'))).toEqual({ kind: 'usage' });
    expect(classifyBlob(blobName('auth.token'))).toBeNull();
    expect(classifyBlob(blobName('transcript.replicas.../x'))).toBeNull();
    expect(classifyBlob('sand-secrets.json')).toBeNull();
    expect(classifyBlob('Cookies')).toBeNull();
    expect(classifyBlob('not base32!.blob')).toBeNull();
  });

  it('readBlob refuses a file whose own name is off the allowlist, even when asked for that kind', async () => {
    await write('sand-secrets.json', roster([row()]));
    expect(await readBlob(path.join(dir, 'sand-secrets.json'), 'roster')).toBeNull();
  });
});

describe('GrokBotIndex', () => {
  it('lists roster rows as read-only Grok entries and never opens forbidden files', async () => {
    await write(blobName('roster.last-roster'), roster([row(), row({ id: 'hidden-1', isHiddenFromSidebar: true }), row({ id: 'bad:id' })]));
    await write(blobName(`transcript.replicas.${AGENT}`), { schemaVersion: 1, value: { entries: [] } });
    await write(blobName('secret.vault'), '{"schemaVersion":4,"value":{"rows":[]}}');
    await write('sand-secrets.json', '{}');
    await write('box-secrets-push-state.v1.json', '{}');
    await write('Cookies', 'x');
    await fs.mkdir(path.join(dir, 'Local Storage'));
    await write(path.join('Local Storage', 'leveldb'), 'x');
    const read = vi.spyOn(fs, 'readFile');
    const idx = new GrokBotIndex(dir, '/home/test');
    await idx.refresh();
    const opened = read.mock.calls.map((c) => path.basename(String(c[0])));
    expect(opened).toEqual([blobName('roster.last-roster')]);
    expect(idx.list()).toEqual([expect.objectContaining({
      sessionId: GROKBOT_ID_PREFIX + AGENT, engine: 'grok', source: 'grokbot', readOnly: true, imported: true, account: 'x1', cwd: '/home/test',
      title: '여행 계획', preview: '다음 주 일정 정리', file: path.join(dir, blobName(`transcript.replicas.${AGENT}`)),
      grokBot: { description: '도쿄 여행', awaitingUserResponse: false, unreadCount: 2, isGroup: false },
    })]);
    expect(idx.list()[0]!.sessionId).not.toContain(':');
    expect(await idx.activeAgeMs()).toBeNull();
  });

  it('a missing folder (or none on this OS) is silently empty; an unknown roster schema is skipped', async () => {
    const none = new GrokBotIndex(path.join(dir, 'nope'), '/h');
    await none.refresh();
    expect(none.list()).toEqual([]);
    const off = new GrokBotIndex(null, '/h');
    await off.refresh();
    expect(off.list()).toEqual([]);
    await write(blobName('roster.last-roster'), roster([row()], 5));
    const idx = new GrokBotIndex(dir, '/h');
    await idx.refresh();
    expect(idx.list()).toEqual([]);
  });

  it('reports the weekly usage when present and not expired', async () => {
    await write(blobName('roster.last-roster'), roster([]));
    await write(blobName('weekly-usage.cache'), { schemaVersion: 2, value: { kind: 'present', reading: { usage: { percentUsed: 42.5, nextResetMs: 2_000, grokPlanLabel: 'SuperGrok' }, readAtMs: 1_000 }, expiresAtMs: 5_000 } });
    const got: unknown[] = [];
    const idx = new GrokBotIndex(dir, '/h', () => 3_000);
    idx.onUsage = (u) => got.push(u);
    await idx.refresh();
    expect(got).toEqual([{ percentUsed: 42.5, nextResetMs: 2_000, planLabel: 'SuperGrok', readAtMs: 1_000 }]);
  });
});

describe('readGrokBotWeeklyUsage', () => {
  it('skips absent, expired and unknown-schema caches', async () => {
    const f = path.join(dir, blobName('weekly-usage.cache'));
    const body = (value: unknown, schemaVersion = 2) => fs.writeFile(f, JSON.stringify({ schemaVersion, value }));
    await body({ kind: 'absent' });
    expect(await readGrokBotWeeklyUsage([f], 0)).toBeNull();
    await body({ kind: 'present', reading: { usage: { percentUsed: 1 }, readAtMs: 1 }, expiresAtMs: 10 });
    expect(await readGrokBotWeeklyUsage([f], 10)).toBeNull();
    expect(await readGrokBotWeeklyUsage([f], 9)).toMatchObject({ percentUsed: 1, nextResetMs: null, planLabel: null });
    await body({ kind: 'present', reading: { usage: { percentUsed: 1 }, readAtMs: 1 } }, 3);
    expect(await readGrokBotWeeklyUsage([f], 0)).toBeNull();
  });
});

describe('readGrokBotTranscript', () => {
  it('maps message = user, send-message = bot, voice calls and widgets to one-liners, skipping unknown kinds', async () => {
    const f = path.join(dir, blobName(`transcript.replicas.${AGENT}`));
    await fs.writeFile(f, JSON.stringify({ schemaVersion: 1, value: { entries: [
      { seq: 3, kind: 'send-message', timestampMs: 3, message: { type: 'widget', widget: { prompt: '어디로 갈까요?', options: [{ label: '도쿄' }, { label: '오사카' }] } }, respondedValue: '도쿄' },
      { seq: 1, kind: 'message', role: 'user', content: '여행 가고 싶어', timestampMs: 1 },
      { seq: 2, kind: 'send-message', timestampMs: 2, message: { type: 'text', content: '좋아요' } },
      { seq: 4, kind: 'send-message', message: { type: 'widget', widget: { options: [] } }, widgetSkipped: true },
      { seq: 5, kind: 'voice-call' },
      { seq: 6, kind: 'send-message', message: { type: 'local-tool-permission', ask: { action: 'read', target: 'notes.txt' } } },
      { seq: 7, kind: 'send-message', message: { type: 'attachment', file_name: 'plan.pdf' } },
      { seq: 8, kind: 'mystery', content: 'x' },
      { seq: 9, kind: 'send-message', message: { type: 'mystery' } },
    ] } }));
    const msgs = await readGrokBotTranscript(f);
    expect(msgs.map((m) => [m.kind, 'text' in m ? m.text : ''])).toEqual([
      ['user', '여행 가고 싶어'],
      ['assistant', '좋아요'],
      ['assistant', '어디로 갈까요? [선택지: 도쿄 · 오사카]'],
      ['user', '도쿄'],
      ['assistant', '[선택지: 없음]'],
      ['user', '[건너뜀]'],
      ['user', '[음성 통화]'],
      ['assistant', '[권한 요청: read notes.txt]'],
      ['assistant', '[첨부: plan.pdf]'],
    ]);
    expect(msgs[0]).toMatchObject({ ts: new Date(1).toISOString() });
  });

  it('an unknown transcript schema reads as empty', async () => {
    const f = path.join(dir, blobName(`transcript.replicas.${AGENT}`));
    await fs.writeFile(f, JSON.stringify({ schemaVersion: 2, value: { entries: [{ seq: 1, kind: 'message', content: 'x' }] } }));
    expect(await readGrokBotTranscript(f)).toEqual([]);
  });
});
