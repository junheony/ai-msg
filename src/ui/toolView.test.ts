import { describe, expect, it } from 'vitest';
import { canonicalTool, commandOf, inputView, outputView, tailOf } from './toolView';

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

  it('turns only path keys relative, and nothing when the folder is the disk root', () => {
    expect(inputView('Grep', { pattern: '/work/proj', glob: '/work/proj/*.ts' }, cwd)).toEqual({
      kind: 'fields', path: null, fields: [{ key: 'pattern', value: '/work/proj' }, { key: 'glob', value: '/work/proj/*.ts' }],
    });
    expect(inputView('Bash', { command: 'ls', workdir: '/work/proj/src' }, cwd)).toMatchObject({ fields: [{ key: 'workdir', value: 'src' }] });
    expect(inputView('Read', { file_path: '/etc/hosts' }, '/')).toMatchObject({ path: '/etc/hosts' });
  });

  it('keeps nested values as compact JSON and a string input as is', () => {
    expect(inputView('mcp__x__y', { a: { b: 1 } }, cwd)).toEqual({ kind: 'fields', path: null, fields: [{ key: 'a', value: '{"b":1}' }] });
    expect(inputView('apply_patch', '*** Begin Patch', cwd)).toEqual({ kind: 'raw', text: '*** Begin Patch' });
  });
});

describe('commandOf', () => {
  it('quotes argv words the shell would read differently, so a pasted copy runs the same thing', () => {
    expect(commandOf({ command: ['echo', 'a;rm'] })).toBe("echo 'a;rm'");
    expect(commandOf({ command: ['grep', '-e', 'a b$HOME'] })).toBe("grep -e 'a b$HOME'");
    expect(commandOf({ command: ['printf', ''] })).toBe("printf ''");
    expect(commandOf({ command: ['echo', 'a\nb'] })).toBe("echo 'a\nb'");
    expect(commandOf({ command: ['echo', "it's"] })).toBe("echo 'it'\\''s'");
    expect(commandOf({ command: ['git', 'log', '--format=%h', 'src/a.ts'] })).toBe('git log --format=%h src/a.ts');
  });
  it('gives a `bash -lc` script back unchanged', () => {
    expect(commandOf({ command: ['bash', '-lc', "echo 'x' | wc -l"] })).toBe("echo 'x' | wc -l");
    expect(commandOf({ command: ['/bin/zsh', '-c', 'a && b'] })).toBe('a && b');
  });
});

describe('outputView', () => {
  it('reads Claude and Grok exit codes out of the text', () => {
    expect(outputView('Exit code 2\nboom', 'Bash', true)).toEqual({ text: 'boom', exitCode: 2, serverCut: null });
    expect(outputView('hi\nexit: 0\n', 'grok:run_terminal_command', false)).toEqual({ text: 'hi', exitCode: 0, serverCut: null });
    expect(outputView('plain', 'Bash', false)).toEqual({ text: 'plain', exitCode: null, serverCut: null });
  });

  it('does not read an exit code out of output that only looks like one', () => {
    // A successful Bash printing "Exit code 1" first (cat of a log), a Read of such a file, a non-shell Grok tool.
    expect(outputView('Exit code 1\nok', 'Bash', false)).toEqual({ text: 'Exit code 1\nok', exitCode: null, serverCut: null });
    expect(outputView('Exit code 1\nok', 'Read', true)).toMatchObject({ exitCode: null });
    expect(outputView('log\nexit: 1', 'Bash', false)).toMatchObject({ text: 'log\nexit: 1', exitCode: null });
    expect(outputView('log\nexit: 1', 'grok:read_file', false)).toMatchObject({ exitCode: null });
    expect(outputView('log\nexit: 1', 'shell', true)).toMatchObject({ exitCode: null });
  });

  it("takes the server's cut marker off and says what was kept", () => {
    expect(outputView('abcd\n…[잘림: 원래 9000자]', 'Read', false)).toEqual({ text: 'abcd', exitCode: null, serverCut: { shown: 4, total: 9000 } });
  });
});

describe('tailOf', () => {
  const text = Array.from({ length: 40 }, (_, i) => `l${i + 1}`).join('\n');
  it('keeps the last lines and counts the rest', () => {
    const t = tailOf(text, 12, 3000);
    expect(t.hiddenLines).toBe(28);
    expect(t.text.split('\n')).toHaveLength(12);
    expect(t.text.endsWith('l40')).toBe(true);
    expect(t.lineCount).toBe(40);
  });
  it('shows a text barely over the limit whole, and bounds one huge line by characters', () => {
    expect(tailOf(text.split('\n').slice(0, 14).join('\n'), 12, 3000).hiddenLines).toBe(0);
    expect(tailOf('x'.repeat(5000), 12, 3000)).toEqual({ text: 'x'.repeat(3000), hiddenLines: 0, hiddenChars: 2000, lineCount: 1 });
  });
});

it('maps other engines to the Claude tool names', () => {
  expect(canonicalTool('grok:search_replace')).toBe('Edit');
  expect(canonicalTool('run_shell_command')).toBe('Bash');
  expect(canonicalTool('Read')).toBe('Read');
});
