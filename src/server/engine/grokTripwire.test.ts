import { describe, expect, it } from 'vitest';
import { isReadOnlyShell, isTripwire } from './grokTripwire';

describe('isReadOnlyShell', () => {
  it('read commands, git reads, mkdir and touch (Grok S13 list) pass', () => {
    for (const c of ['ls -la', 'cat a.txt | head -5', 'git status', 'git --no-pager log --oneline -5', 'git -C sub diff HEAD', 'rg foo src 2>/dev/null', 'find . -name "*.ts"', 'mkdir -p out', 'touch x', 'cd src && ls', 'wc -l a b; pwd', 'git branch -a', 'echo "a > b"']) {
      expect(isReadOnlyShell(c), c).toBe(true);
    }
  });

  it('writes, redirects, substitutions and unknown commands do not', () => {
    for (const c of ['rm -f x', 'printf sub > sub.txt', 'echo x >> a', 'cat <<EOF', 'ls $(rm x)', 'ls `rm x`', 'find . -delete', 'find . -exec rm {} ;', 'git commit -m x', 'git push', 'git branch -D x', 'git -c core.pager=sh log', 'sed -i s/a/b/ f', 'FOO=1 ls', 'node x.js', 'sort -o out in', 'sleep 1 &', '', 'git']) {
      expect(isReadOnlyShell(c), c).toBe(false);
    }
  });
});

describe('isReadOnlyShell: quoting tricks and run/output flags', () => {
  it('a word with a quote, backslash or $ inside (not one whole quoted word) is not read-only', () => {
    for (const c of [
      'find . -"exec" rm {} +', "find . -'exec' rm {} +", 'find . -ex\\ec rm {} +', 'find . "-exec" rm {} +', "find . '-delete'",
      'sort "-o" out in', 'l"s"', 'ls $HOME', 'cat "$F"', 'cat "a\\"b"', 'echo a"b"', 'echo "a"b', 'ls \\$(x)',
    ]) {
      expect(isReadOnlyShell(c), c).toBe(false);
    }
    // One whole quoted word with plain text inside is still data.
    for (const c of ['find . -name "*.ts"', "rg 'foo bar' src", 'echo "a > b"', "grep -n 'a|b' f"]) {
      expect(isReadOnlyShell(c), c).toBe(true);
    }
  });

  it('flags that run a program or write a file are not read-only', () => {
    for (const c of [
      'fd -x rm', 'fd -X rm', 'fd --exec rm', 'fd --exec-batch rm', 'fd -Hx rm', 'fd . --exec=rm',
      'rg --pre ./evil foo', 'rg --pre=./evil foo', 'ag --pager ./evil foo',
      'tree -o out.txt', 'tree -oout.txt', 'tree --output out',
      'sort -o out in', 'sort -uo out in', 'sort --output=out in', 'sort --compress-program=./evil in', 'sort --compress-program ./evil in',
      'git grep -O foo', 'git grep -O./evil foo', 'git grep --open-files-in-pager foo', 'git grep --open-files-in-pager=./evil foo',
      'uniq in out', 'file -C -m magic',
    ]) {
      expect(isReadOnlyShell(c), c).toBe(false);
    }
    for (const c of ['fd -H foo', 'fd -e ts', 'rg -n foo', 'tree -L 2', 'sort -u in', 'sort -n -r in', 'git grep -n foo', 'uniq -c', 'uniq -f 1 in', 'file a.txt']) {
      expect(isReadOnlyShell(c), c).toBe(true);
    }
  });
});

describe('isTripwire', () => {
  it('a changing kind that is not on the read list trips', () => {
    expect(isTripwire('edit', 'write', { file_path: '/w/a' })).toBe(true);
    expect(isTripwire('delete', 'delete_file', {})).toBe(true);
    expect(isTripwire('move', null, {})).toBe(true);
    expect(isTripwire('execute', 'run_terminal_command', { variant: 'Bash', command: 'printf sub > sub.txt' })).toBe(true);
    expect(isTripwire('execute', 'run_terminal_command', {})).toBe(true);
  });

  it('read kinds, read tools and read-only shell do not', () => {
    expect(isTripwire('read', 'read_file', {})).toBe(false);
    expect(isTripwire('search', 'grep', {})).toBe(false);
    expect(isTripwire('other', 'spawn_subagent', {})).toBe(false);
    expect(isTripwire('edit', 'todo_write', {})).toBe(false);
    expect(isTripwire('execute', 'run_terminal_command', { command: 'git status && ls' })).toBe(false);
    expect(isTripwire('execute', 'run_terminal_command', { command: 'mkdir -p a/b' })).toBe(false);
  });
});
