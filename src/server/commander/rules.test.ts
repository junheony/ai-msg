import { describe, it, expect } from 'vitest';
import { gateTool, isAllowedCommand, isProtectedEditPath } from './rules';

const clean = { runnerConfigChanged: false };
const changed = { runnerConfigChanged: true };
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
