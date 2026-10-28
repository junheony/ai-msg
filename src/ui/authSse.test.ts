import { describe, expect, it } from 'vitest';
import { takeSse } from './authSse';

describe('takeSse', () => {
  it('splits events and keeps a partial block', () => {
    const first = takeSse('event: out\ndata: {"text":"hi"}\n\nevent: ex');
    expect(first.events).toEqual([{ event: 'out', data: '{"text":"hi"}' }]);
    expect(first.rest).toBe('event: ex');
    const next = takeSse(`${first.rest}it\ndata: {"code":0}\n\n`);
    expect(next.events).toEqual([{ event: 'exit', data: '{"code":0}' }]);
    expect(next.rest).toBe('');
  });
});
