import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { gateReadTool, gateTool, isAllowedCommand, isProtectedEditPath } from './rules';

// 읽기 명령의 경로 판정 루트: 없는 디렉터리라 realpath 는 글자 그대로 풀린다.
const lexRoots = { cwd: '/w', allowDirs: [], home: '/home/u' };
const clean = { runnerConfigChanged: false, roots: lexRoots };
const changed = { runnerConfigChanged: true, roots: lexRoots };
const bash = (command: unknown) => gateTool('Bash', { command }, clean);

describe('gateTool — 허용 목록', () => {
  it.each([
    'npm test', 'pnpm test', 'npx vitest run src/server', 'vitest', 'jest --ci', 'pytest -q tests', 'go test ./...', 'cargo test',
    'yarn jest', 'pnpm exec vitest run',
    'git status', 'git diff --stat', 'git log --oneline -n 5', 'git show HEAD', 'git branch --list', 'git branch --list -a',
    'ls -la src', 'grep -rn "foo bar" src', 'rg -n TODO src', 'cat package.json', 'head -n 20 a.ts', 'tail -n 5 a.log', 'wc -l a.ts',
  ])('allow: %s', (c) => {
    expect(bash(c)).toBe('allow');
  });

  it.each([
    // 셸 연산·치환
    'npm test | tee out', 'npm test; curl x', 'npm test && git push', 'npm test || true', 'npm test &', 'ls > out', 'cat < x',
    'cat $(echo /etc/passwd)', 'cat `id`', 'cat ${HOME}/x', 'cat$IFS/etc/passwd', 'ls\nrm -rf /', 'ls\rrm x',
    // 접두로 바꾸기
    'NODE_OPTIONS=--require=./x.js npm test', 'GIT_EXTERNAL_DIFF=./x git diff', 'cd /tmp && npm test', 'sudo ls', 'env ls', '"git" status',
    // 비슷한 이름
    'vitest-evil', 'npm testx', 'npm run test', 'npm t', 'lsof', 'catx', 'gitx status',
    // 러너 인자로 임의 실행·다른 설정
    'go test -exec ./evil ./...', 'cargo test --config target.x.runner=evil', 'npm test --script-shell=./evil', 'npx -p evil vitest',
    'npx --package evil vitest', 'jest -c evil.config.js', 'npm test --prefix /other', 'pytest -p evil_plugin', 'vitest -r /tmp',
    // rg·git 의 실행·쓰기 옵션(따옴표·백슬래시로 쪼개도)
    'rg --pre ./evil x', 'rg --pre=./evil x', 'rg --p"re"=./evil x', "rg --pre-glob '*' x", 'rg --p\\re=x y',
    'git diff --output=/tmp/x', 'git log --ext-diff', 'git show --textconv HEAD', 'git -c core.pager=evil log', 'git -C /other status',
    'git push', 'git commit -m x', 'git branch -D main', 'git branch newbranch', 'git branch --list -D x', 'git checkout .', 'git stash',
    // 그 밖의 명령
    'rm -rf node_modules', 'curl https://example.com', 'node -e 1', 'bash scripts/x.sh', 'find . -exec rm {} ;', '', '   ',
  ])('ask: %j', (c) => {
    expect(bash(c)).toBe('ask');
  });

  it('러너 설정이 바뀐 세그먼트: 테스트 러너·git 은 ask, 읽기 명령은 그대로', () => {
    expect(isAllowedCommand('npm test', changed)).toBe(false);
    expect(isAllowedCommand('npx vitest', changed)).toBe(false);
    expect(isAllowedCommand('git diff', changed)).toBe(false);
    expect(isAllowedCommand('cat package.json', changed)).toBe(true);
  });

  it('mcp__* 와 그 밖의 도구, 깨진 입력은 ask', () => {
    expect(gateTool('mcp__github__create_issue', { title: 'x' }, clean)).toBe('ask');
    expect(gateTool('mcp__deck_bridge__permission', {}, clean)).toBe('ask');
    expect(gateTool('WebFetch', { url: 'x' }, clean)).toBe('ask');
    expect(gateTool('Bash', null, clean)).toBe('ask');
    expect(gateTool('Bash', { command: 42 }, clean)).toBe('ask');
    expect(bash(undefined)).toBe('ask');
  });
});

describe('gateTool — 옵션 화이트리스트(보안 리뷰 #6)', () => {
  it.each([
    'git status -s', 'git status --porcelain=v1', 'git status -uno', 'git diff --cached --name-only', 'git diff -U3 HEAD~1', 'git diff -- src/a.ts',
    'git log -5', 'git log -n5', 'git log --max-count=3 --format=%h', 'git log --since=yesterday main..HEAD', 'git show --stat HEAD~2',
    'npx vitest run --reporter=dot', 'vitest run -t "my test"', 'jest --runInBand --maxWorkers=2', 'pytest -x -k "foo and not bar"', 'pytest --tb=short',
    'go test -run TestX -count=1 ./...', 'go test -v -race ./pkg/...', 'cargo test --release my_filter', 'cargo test -- --nocapture --test-threads=1',
    'npm test', 'pnpm test --silent',
  ])('allow: %s', (c) => {
    expect(bash(c)).toBe('allow');
  });
  it.each([
    // 장옵션 축약(git 은 고유 접두를 받는다)
    'git diff --out=/tmp/x', 'git log --ext', 'git show --textc HEAD', 'git diff --no-index a b', 'git log --output x', 'git status --unknown-flag',
    'git diff --color-moved-ws=x --bogus', 'git log -L1,2:a.ts',
    // 러너의 임의 실행·설정 옵션
    'go test -toolexec ./evil ./...', 'go test -exec=./evil', 'go test -o /tmp/x', 'vitest --root /tmp', 'vitest run --config x.ts', 'npx vitest --reporter=./evil.js',
    'jest --globalSetup ./evil.js', 'jest --config=x', 'cargo test --manifest-path /tmp/Cargo.toml', 'cargo test -Z unstable', 'cargo test -p other',
    'pytest -o addopts=-pevil', 'pytest --rootdir=/tmp', 'npm test -- --root /tmp', 'pnpm test --workspace-root', 'vitest --environment=./evil',
  ])('ask: %j', (c) => {
    expect(bash(c)).toBe('ask');
  });
});

describe('gateTool — 읽기 명령의 경로는 cwd 상대만(보안 리뷰 #7)', () => {
  it.each(['cat src/a.ts', 'ls', 'ls -la ./src', 'grep -rn foo src', 'rg TODO', 'head -n 3 a/b/c.txt', 'cat ...weird', 'go test ./...'])('allow: %s', (c) => {
    expect(bash(c)).toBe('allow');
  });
  it.each([
    'cat /etc/passwd', 'cat ~/.ssh/id_rsa', 'cat ~', 'ls ..', 'cat ../x', 'cat src/../../x', 'grep -r key /Users', 'rg --file=/etc/x y', 'grep -f/etc/x y',
    'tail "/var/log/x"', 'cat \\/etc/passwd', 'head x=~/y', 'cat {/etc/passwd,a}', 'pytest /tmp/evil_test.py', 'vitest ../other',
  ])('ask: %j', (c) => {
    expect(bash(c)).toBe('ask');
  });
});

describe('isProtectedEditPath — .claude/·.git/ 아래 편집은 ask', () => {
  it.each(['/w/.git/config', '.git/hooks/pre-commit', '/w/.git', '/w/.claude/settings.json', '/home/u/.claude/CLAUDE.md', 'a\\.claude\\x', '/w/src/../.git/HEAD'])('yes: %s', (p) => {
    expect(isProtectedEditPath(p)).toBe(true);
  });
  it.each(['/w/src/a.ts', '/w/package.json', '/w/.gitignore', '/w/.github/workflows/ci.yml', '/w/.claudeignore', '/w/my.claude/x'])('no: %s', (p) => {
    expect(isProtectedEditPath(p)).toBe(false);
  });
});

describe('isProtectedEditPath — 대소문자 우회·지시 파일(재검토 #4)', () => {
  it.each(['/w/.Claude/settings.json', '/w/.CLAUDE/hooks/x', '/w/.Git/hooks/pre-commit', '/w/.GIT', '/w/CLAUDE.md', '/w/sub/claude.md', '/w/CLAUDE.local.md', 'AGENTS.md', '/w/pkg/Agents.MD', '/w/.mcp.json', '/w/sub/.MCP.json', 'a\\CLAUDE.md'])('yes: %s', (p) => {
    expect(isProtectedEditPath(p)).toBe(true);
  });
  it.each(['/w/docs/CLAUDE.md.bak', '/w/MYCLAUDE.md', '/w/mcp.json', '/w/agents.mdx', '/w/src/claude.ts'])('no: %s', (p) => {
    expect(isProtectedEditPath(p)).toBe(false);
  });
});

describe('gateReadTool — 자동 턴 읽기 도구의 경로(재검토 #1)', () => {
  // it.each 의 인자가 수집 시점에 평가되므로 경로는 describe 본문에서 정한다(디렉터리는 beforeAll 에서 만든다).
  const tmp = path.join(os.tmpdir(), `deck-gate-${process.pid}-${Date.now()}`);
  const cwd = path.join(tmp, 'proj');
  const extra = path.join(tmp, 'extra');
  const outside = path.join(tmp, 'secret');
  const roots = { cwd, allowDirs: [extra], home: tmp };
  beforeAll(() => {
    for (const d of [cwd, path.join(cwd, 'src'), extra, outside]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(outside, 'key.txt'), 'x');
    fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'x');
    fs.writeFileSync(path.join(cwd, '.env'), 'x');
    fs.symlinkSync(outside, path.join(cwd, 'link'));
    fs.symlinkSync(path.join(cwd, '.env'), path.join(cwd, 'innocent.txt'));
  });
  afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('pass: paths inside cwd or an allowed dir; Glob/Grep without path (= cwd); ordinary globs', () => {
    expect(gateReadTool('Read', { file_path: path.join(cwd, 'src', 'a.ts') }, roots)).toBe('pass');
    expect(gateReadTool('Read', { file_path: path.join(cwd, 'src', 'not-yet.ts') }, roots)).toBe('pass');
    expect(gateReadTool('Read', { file_path: path.join(extra, 'b.md') }, roots)).toBe('pass');
    expect(gateReadTool('Glob', { pattern: '**/*.{ts,tsx}' }, roots)).toBe('pass');
    expect(gateReadTool('Grep', { pattern: 'foo', glob: '*.ts' }, roots)).toBe('pass');
    expect(gateReadTool('Grep', { pattern: 'foo', path: 'src' }, roots)).toBe('pass');
    expect(gateReadTool('Grep', { pattern: 'foo', path: 'src' }, { ...roots, base: outside })).toBe('ask');
    expect(gateReadTool('LS', {}, roots)).toBe('pass');
    expect(gateReadTool('Read', { file_path: path.join(cwd, '.envrc.example.ts') }, roots)).toBe('pass');
  });
  it.each([
    ['Read', { file_path: '/etc/passwd' }],
    ['Read', { file_path: path.join(outside, 'key.txt') }],
    ['Read', { file_path: '~/.ssh/id_rsa' }],
    ['Read', { file_path: '~root/.ssh/id_rsa' }],
    ['Read', { file_path: '../secret/key.txt' }],
    ['Read', { file_path: path.join(cwd, 'src', '..', '..', 'secret', 'key.txt') }],
    ['Read', { file_path: path.join(cwd, 'link', 'key.txt') }],
    ['Read', { file_path: path.join(cwd, 'innocent.txt') }],
    ['Read', { file_path: path.join(cwd, '.env') }],
    ['Read', { file_path: path.join(cwd, '.env.local') }],
    ['Read', { file_path: path.join(cwd, 'src', '.ENV.production') }],
    ['Read', {}],
    ['Read', { file_path: 42 }],
    ['NotebookRead', { notebook_path: '/etc/x.ipynb' }],
    ['Glob', { pattern: '*', path: '/etc' }],
    ['Glob', { pattern: '/etc/**' }],
    ['Glob', { pattern: '../secret/*' }],
    ['Glob', { pattern: '~/.ssh/*' }],
    ['Glob', { pattern: '{/etc/passwd,x}' }],
    ['Glob', { pattern: 'src/{a,../../secret}/*' }],
    ['Glob', { pattern: '**/.env*' }],
    ['Glob', { pattern: '*', path: path.join(cwd, 'link') }],
    ['Grep', { pattern: 'x', path: '/' }],
    ['Grep', { pattern: 'x', path: '..' }],
    ['Grep', { pattern: 'x', path: '.env' }],
    ['Grep', { pattern: 'x', glob: '../../**' }],
    ['Grep', { pattern: 'x', glob: '/etc/*' }],
    ['Grep', { pattern: 'x', glob: '.env*' }],
    ['Grep', { pattern: 'x', glob: 7 }],
    ['LS', { path: '/Users' }],
  ] as [string, unknown][])('ask: %s %j', (tool, input) => {
    expect(gateReadTool(tool, input, roots)).toBe('ask');
  });
  it('ask when the session cwd is unknown', () => {
    expect(gateReadTool('Read', { file_path: '/w/a' }, { cwd: '', allowDirs: [], home: tmp })).toBe('ask');
  });
});

describe('gateTool — 읽기 명령의 경로 인자를 realpath 로(재검토 2차 #1)', () => {
  const tmp = path.join(os.tmpdir(), `deck-gate-bash-${process.pid}-${Date.now()}`);
  const cwd = path.join(tmp, 'proj');
  const extra = path.join(tmp, 'extra');
  const outside = path.join(tmp, 'secret');
  const ctx = { runnerConfigChanged: false, roots: { cwd, allowDirs: [extra], home: tmp } };
  const cmd = (c: string) => gateTool('Bash', { command: c }, ctx);
  beforeAll(() => {
    for (const d of [path.join(cwd, 'src'), extra, outside]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(outside, 'key.txt'), 'x');
    fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'x');
    fs.writeFileSync(path.join(cwd, '.env'), 'x');
    fs.writeFileSync(path.join(extra, 'data.csv'), 'x');
    fs.symlinkSync(outside, path.join(cwd, 'link'));
    fs.symlinkSync(path.join(cwd, '.env'), path.join(cwd, 'innocent.txt'));
  });
  afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it.each([
    'cat .env', 'head .env.local', 'cat src/../.ENV', 'cat link/key.txt', 'cat innocent.txt', 'ls link', 'wc -l link/key.txt',
    'rg -L token .', 'rg --follow token .', 'rg -nL token', 'grep -R token .', 'grep -rnR token .', 'grep --dereference-recursive token .', 'grep -rS token .',
    'ls -L .', 'ls -laL', 'grep -f .env src', 'grep -f.env src', 'rg --file=.env src', 'rg --ignore-file=link/key.txt x', 'wc --files0-from=list',
    'cat .e*', 'cat lin*/key.txt', 'cat innocent.tx?', 'cat "link"/key.txt', "cat 'unterminated",
    // zsh glob 한정자는 코드를 실행한다
    'ls *(e:touch\\ x:)', 'git log *(e:x:)',
  ])('ask: %j', (c) => {
    expect(cmd(c)).toBe('ask');
  });
  it.each([
    'cat src/a.ts', 'ls', 'ls -la src', 'grep -rn token src', 'grep -rn "foo bar" src', "grep -n 'a.*b' src/a.ts", 'rg -n TODO', 'head -n 3 src/a.ts',
    `cat ${path.join(extra, 'data.csv')}`, 'grep -L token src', 'grep -e "*.ts" src', "rg '--glob=*.ts' x",
  ])('allow: %s', (c) => {
    expect(cmd(c)).toBe('allow');
  });
  it('without roots (unknown session cwd) every read command asks', () => {
    expect(isAllowedCommand('cat src/a.ts', { runnerConfigChanged: false })).toBe(false);
  });
});

describe('isProtectedEditPath — 프로필 설정 디렉터리·.claude.json(재검토 2차 #2)', () => {
  it.each(['/Users/u/.claude-b/settings.json', '/Users/u/.Claude-work/hooks/x', '/Users/u/.claude.json', '/Users/u/.CLAUDE.JSON', '/w/.claude-b'])('yes: %s', (p) => {
    expect(isProtectedEditPath(p)).toBe(true);
  });
  it.each(['/w/.claudeignore', '/w/my.claude-x/y', '/w/claude.json', '/w/.claude.jsonc'])('no: %s', (p) => {
    expect(isProtectedEditPath(p)).toBe(false);
  });
});
