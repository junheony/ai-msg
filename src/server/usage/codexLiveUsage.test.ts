import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCodexLiveUsage, readCodexLiveUsage } from './codexLiveUsage';

const bucket = { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1800000000 }, secondary: { usedPercent: 7, windowDurationMins: 300, resetsAt: null } };

describe('Codex live quota (no inference)', () => {
  it('reads the codex bucket by duration, keeps used percent and credits, rejects invalid/other-model readings', () => {
    expect(parseCodexLiveUsage({ rateLimits: { ...bucket, limitId: 'other' }, rateLimitsByLimitId: { codex: { ...bucket, credits: { hasCredits: true, unlimited: false, balance: '12.4' } } } })).toEqual({
      weekly: { usedPct: 12, resetsAt: new Date(1800000000000).toISOString() }, fiveHour: { usedPct: 7, resetsAt: null }, credits: { hasCredits: true, unlimited: false, balance: 12.4 },
    });
    expect(parseCodexLiveUsage({ rateLimits: { ...bucket, limitId: 'other' } })).toBeNull();
    expect(parseCodexLiveUsage({ rateLimits: { primary: { usedPercent: NaN, windowDurationMins: 300 } } })).toBeNull();
    expect(parseCodexLiveUsage({ rateLimits: { primary: { usedPercent: 101, windowDurationMins: 300 } } })).toBeNull();
    expect(parseCodexLiveUsage({ rateLimits: { ...bucket, primary: { usedPercent: 101, windowDurationMins: 10080 } } })).toBeNull();
  });

  it('handshakes then sends only the quota read; auth failure and timeout never become fake zero usage', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rpc-test-'));
    const bin = path.join(root, 'codex');
    const calls = path.join(root, 'calls.jsonl');
    const script = (response: unknown, hang = false) => `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst rl = require('node:readline').createInterface({input:process.stdin});\nrl.on('line', l => { const m=JSON.parse(l); fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(m)+'\\n'); if(m.id===1) console.log(JSON.stringify({id:1,result:{}})); if(m.id===2 && ${!hang}) console.log(JSON.stringify(${JSON.stringify(response)})); });\n`;
    try {
      await fs.writeFile(bin, script({ id: 2, result: { rateLimits: bucket } }), { mode: 0o700 });
      expect((await readCodexLiveUsage(bin))?.weekly?.usedPct).toBe(12);
      const sent = (await fs.readFile(calls, 'utf8')).trim().split('\n').map(l => JSON.parse(l).method);
      expect(sent).toEqual(['initialize', 'initialized', 'account/rateLimits/read']);
      await fs.writeFile(bin, script({ id: 2, error: { message: 'authentication required' } }));
      expect(await readCodexLiveUsage(bin)).toBeNull();
      await fs.writeFile(bin, script(null, true));
      expect(await readCodexLiveUsage(bin, { timeoutMs: 100 })).toBeNull();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
