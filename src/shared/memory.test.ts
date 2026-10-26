import { describe, expect, it } from 'vitest';
import { MEMORY_MAX_BYTES, deckAddendum, memoryBytes, memoryNote, normalizeMemory } from './memory';

describe('deck 메모', () => {
  it('counts UTF-8 bytes (Korean is 3 a syllable) and caps at 4KB', () => {
    expect(MEMORY_MAX_BYTES).toBe(4096);
    expect(memoryBytes('abc')).toBe(3);
    expect(memoryBytes('메모')).toBe(6);
  });
  it('normalizes line endings and trailing space; blank is empty', () => {
    expect(normalizeMemory('a  \r\nb\r\n\r\n')).toBe('a\nb');
    expect(normalizeMemory(' \n\t ')).toBe('');
  });
  it('memoryNote labels the note; blank is null', () => {
    expect(memoryNote('')).toBeNull();
    expect(memoryNote(null)).toBeNull();
    const n = memoryNote('  답은 한국어로  ')!;
    expect(n.startsWith('[Crew 메모]')).toBe(true);
    expect(n.endsWith('\n답은 한국어로')).toBe(true);
  });
  it('deckAddendum: style first, then memory; null with neither', () => {
    expect(deckAddendum({})).toBeNull();
    expect(deckAddendum({ style: ' ', memory: '' })).toBeNull();
    expect(deckAddendum({ style: 'S' })).toBe('S');
    expect(deckAddendum({ memory: 'M' })).toBe(memoryNote('M'));
    expect(deckAddendum({ style: 'S', memory: 'M' })).toBe(`S\n\n${memoryNote('M')}`);
  });
});
