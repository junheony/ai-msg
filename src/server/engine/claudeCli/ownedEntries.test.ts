// src/server/engine/claudeCli/ownedEntries.test.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { OwnedEntries } from './ownedEntries';
import type { CliMessage } from './messages';

describe('OwnedEntries', () => {
  it('notes assistant uuids and API message ids, user uuids (replays too); ignores the rest', () => {
    const o = new OwnedEntries();
    o.note({ type: 'assistant', parent_tool_use_id: null, uuid: 'a-uuid', message: { id: 'msg_1', content: [] } } as CliMessage);
    o.note({ type: 'user', parent_tool_use_id: null, uuid: 'u-uuid', isReplay: true, message: { role: 'user', content: 'x' } } as CliMessage);
    o.note({ type: 'system', subtype: 'init', uuid: 'sys' } as CliMessage);
    expect(o.has('a-uuid', null)).toBe(true);
    expect(o.has('other-block-uuid', 'msg_1')).toBe(true); // same API message, another content-block entry
    expect(o.has('u-uuid', null)).toBe(true);
    expect(o.has('sys', null)).toBe(false);
    expect(o.has('x', null)).toBe(false);
  });
  it('stdin uuids deck sent are added directly', () => {
    const o = new OwnedEntries();
    o.add('00000000-0000-4000-8000-000000000001');
    expect(o.has('00000000-0000-4000-8000-000000000001', null)).toBe(true);
  });
  it('is bounded: the oldest keys go first', () => {
    const o = new OwnedEntries(3);
    for (const k of ['a', 'b', 'c', 'd']) o.add(k);
    expect(o.size).toBe(3);
    expect(o.has('a', null)).toBe(false);
    expect(o.has('d', null)).toBe(true);
  });
});

it('G1: every main-chain entry of a real run is claimed by its stdout', () => {
  const m = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'owned-uuids.meta.json'), 'utf8'));
  expect(m.unowned).toEqual([]);
  expect(m.entrypoints).not.toContain('sdk-ts');
});
