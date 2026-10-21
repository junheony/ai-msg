import { describe, expect, it } from 'vitest';
import { readHashToken } from './loginHash';

describe('readHashToken', () => {
  it('decodes #token=', () => {
    expect(readHashToken('#token=a%2Bb')).toBe('a+b');
    expect(readHashToken('#token=abc123')).toBe('abc123');
    expect(readHashToken('#x=1&token=t')).toBe('t');
  });
  it('is null without a token', () => {
    expect(readHashToken('#x=1')).toBeNull();
    expect(readHashToken('')).toBeNull();
    expect(readHashToken('#token=')).toBeNull();
    expect(readHashToken('#token=%E0%A4%A')).toBeNull();
  });
  it('keeps a literal +', () => {
    expect(readHashToken('#token=a+b')).toBe('a+b');
  });
});
