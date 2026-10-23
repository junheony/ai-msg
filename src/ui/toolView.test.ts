import { describe, expect, it } from 'vitest';
import { canonicalTool, inputView, outputView, tailOf } from './toolView';

const cwd = '/work/proj';

describe('inputView', () => {
  it('shows a shell call as its command, for every engine', () => {
    expect(inputView('Bash', { command: 'ls -la', description: 'list' }, cwd)).toEqual({ kind: 'command', command: 'ls -la', fields: [] });
    expect(inputView('shell', { command: ['bash', '-lc', 'npm test'] }, cwd)).toMatchObject({ kind: 'command', command: 'npm test' });
    expect(inputView('exec_command', { cmd: 'git status' }, cwd)).toMatchObject({ kind: 'command', command: 'git status' });
    expect(inputView('grok:run_terminal_command', { variant: 'Bash', command: 'printf hi', description: 'x', is_background: false }, cwd)).toEqual({ kind: 'command', command: 'printf hi', fields: [] });
    expect(inputView('Bash', { command: 'sleep 9', timeout: 60000, run_in_background: true }, cwd)).toMatchObject({ fields: [{ key: 'timeout', value: '60000' }, { key: 'run_in_background', value: 'true' }] });
  });

  it('shows a file path relative to the session folder, with the other keys', () => {
    expect(inputView('Read', { file_path: '/work/proj/src/a.ts', offset: 10 }, cwd)).toEqual({ kind: 'fields', path: 'src/a.ts', fields: [{ key: 'offset', value: '10' }] });
    expect(inputView('grok:write', { variant: 'Write', file_path: '/elsewhere/b.txt', content: 'hi' }, cwd)).toEqual({ kind: 'fields', path: '/elsewhere/b.txt', fields: [] });
    expect(inputView('Grep', { pattern: 'x', path: '/work/proj' }, cwd)).toMatchObject({ path: '.' });
  });

  it('keeps nested values as compact JSON and a string input as is', () => {
    expect(inputView('mcp__x__y', { a: { b: 1 } }, cwd)).toEqual({ kind: 'fields', path: null, fields: [{ key: 'a', value: '{"b":1}' }] });
    expect(inputView('apply_patch', '*** Begin Patch', cwd)).toEqual({ kind: 'raw', text: '*** Begin Patch' });
  });
});

describe('outputView', () => {
  it('reads Claude and Grok exit codes out of the text', () => {
    expect(outputView('Exit code 2\nboom')).toEqual({ text: 'boom', exitCode: 2, serverCut: null });
    expect(outputView('hi\nexit: 0\n')).toEqual({ text: 'hi', exitCode: 0, serverCut: null });
    expect(outputView('plain')).toEqual({ text: 'plain', exitCode: null, serverCut: null });
  });

  it("takes the server's cut marker off and says what was kept", () => {
    expect(outputView('abcd\n…[잘림: 원래 9000자]')).toEqual({ text: 'abcd', exitCode: null, serverCut: { shown: 4, total: 9000 } });
  });
});

describe('tailOf', () => {
  const text = Array.from({ length: 40 }, (_, i) => `l${i + 1}`).join('\n');
  it('keeps the last lines and counts the rest', () => {
    const t = tailOf(text, 12, 3000);
    expect(t.hiddenLines).toBe(28);
    expect(t.text.split('\n')).toHaveLength(12);
    expect(t.text.endsWith('l40')).toBe(true);
  });
  it('shows a text barely over the limit whole, and bounds one huge line by characters', () => {
    expect(tailOf(text.split('\n').slice(0, 14).join('\n'), 12, 3000).hiddenLines).toBe(0);
    expect(tailOf('x'.repeat(5000), 12, 3000)).toEqual({ text: 'x'.repeat(3000), hiddenLines: 0, hiddenChars: 2000 });
  });
});

it('maps other engines to the Claude tool names', () => {
  expect(canonicalTool('grok:search_replace')).toBe('Edit');
  expect(canonicalTool('run_shell_command')).toBe('Bash');
  expect(canonicalTool('Read')).toBe('Read');
});
