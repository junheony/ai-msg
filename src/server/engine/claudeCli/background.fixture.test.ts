import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseLine, type CliMessage } from './messages';
import { BackgroundTracker, mapCliMessage, isActivity } from './stream';
import { ClaudeProcess } from './process';
import { fakeClaudeCli } from './fakeClaudeCli';

// Same value as fixtures/capture.ts FIRST_UUID (capture.ts is dev-only and not imported by tests).
const FIRST_UUID = '00000000-0000-4000-8000-000000000001';

const dir = path.join(__dirname, 'fixtures');
const frames = (): CliMessage[] => fs.readFileSync(path.join(dir, 'background.jsonl'), 'utf8').split('\n').map(parseLine).filter((m): m is CliMessage => m !== null);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'background.meta.json'), 'utf8')) as {
  aliveAfterFirstResult: boolean; results: { uuids: string[] | null; tasksLive: number }[];
  sawLevel?: boolean; sawTaskStarted?: boolean; sawNotification?: boolean; exit: { code: number | null };
};

describe('background fixture (real CLI, print mode, stdin open)', () => {
  it('H1/H4: alive after the first result while a task runs; clean exit after stdin closes', () => {
    expect(meta.aliveAfterFirstResult).toBe(true);
    expect(meta.results[0]!.tasksLive).toBe(1);
    expect(meta.exit.code).toBe(0);
  });

  it('H2: the tracker sees the task come and go from the recorded frames', () => {
    const bg = new BackgroundTracker(() => 0);
    const live: number[] = [];
    for (const m of frames()) { if (bg.apply(m)) live.push(bg.tasks().length); }
    expect(live).toContain(1);
    expect(live.at(-1)).toBe(0);
    expect(meta.sawLevel === true || (meta.sawTaskStarted === true && meta.sawNotification === true)).toBe(true);
  });

  it('H3: two results; the continuation names none of deck’s prompts and is preceded by main-thread activity', () => {
    const fs_ = frames();
    const results = fs_.filter((m) => m.type === 'result');
    expect(results).toHaveLength(2);
    expect(meta.results[0]!.uuids).toContain(FIRST_UUID);
    expect(meta.results[1]!.uuids ?? []).not.toContain(FIRST_UUID);
    const firstResult = fs_.indexOf(results[0]!);
    const between = fs_.slice(firstResult + 1, fs_.indexOf(results[1]!));
    expect(between.some((m) => isActivity(m))).toBe(true);
  });

  it('the mapper turns the recorded notification into task_done and both results into results', () => {
    const evs = frames().flatMap((m) => mapCliMessage(m));
    expect(evs.some((e) => e.kind === 'task_done')).toBe(true);
    expect(evs.filter((e) => e.kind === 'result')).toHaveLength(2);
  });

  it('ClaudeProcess does not end the stream at a result: frames after the first result still arrive', async () => {
    const fake = fakeClaudeCli({ exitOnStdinClose: true });
    const p = new ClaudeProcess({ bin: 'claude', args: [], cwd: '/w', env: {}, spawnFn: fake.spawnFn });
    p.start();
    fake.push(...frames());
    const got: CliMessage[] = [];
    for await (const m of p.messages()) {
      got.push(m);
      if (got.filter((x) => x.type === 'result').length === 2) p.stop();
    }
    expect(got.filter((m) => m.type === 'result')).toHaveLength(2);
    expect(fake.state.inputClosed).toBe(true);
    expect((await p.exited).code).toBe(0);
  });
});
