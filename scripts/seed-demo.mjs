#!/usr/bin/env node
/**
 * Local demo config for the MSG UI: a login token and fake Claude transcripts.
 * No Claude login, no network. The server still has to be started separately.
 *
 *   node scripts/seed-demo.mjs [--dir DIR]
 *
 * Prints shell assignments (DECK_CONFIG_DIR, DECK_HOME, DECK_EXTRA_CWD_ROOTS)
 * and a login URL for port 9320. Re-running the same --dir keeps the token.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dirFlag = args.indexOf('--dir');
const root = path.resolve(dirFlag >= 0 ? args[dirFlag + 1] : path.join(process.cwd(), '.demo'));
const configDir = path.join(root, 'config');
const home = path.join(root, 'home');
const work = path.join(root, 'work');
const profile = path.join(home, '.claude');

const TOKEN_RE = /^[0-9a-f]{64}$/;
function token() {
  const file = path.join(configDir, 'token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (TOKEN_RE.test(existing)) return existing;
  } catch { /* create */ }
  return randomBytes(32).toString('hex');
}

const line = (o) => JSON.stringify(o);
const id = (n) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`.slice(0, 36);

function session({ uuid, cwd, title, records, mtime }) {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(profile, 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${uuid}.jsonl`);
  const body = [
    line({ type: 'custom-title', customTitle: title, cwd, sessionId: uuid }),
    ...records,
  ].join('\n') + '\n';
  fs.writeFileSync(file, body);
  const when = mtime / 1000;
  fs.utimesSync(file, when, when);
  return uuid;
}

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const messenger = path.join(work, 'messenger');
const notes = path.join(work, 'notes');
fs.mkdirSync(messenger, { recursive: true });
fs.mkdirSync(notes, { recursive: true });
fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(profile, { recursive: true });

const rich = id('1');
const layout = id('2');
const notesId = id('3');
const auto = id('4');
const empty = id('5');

session({
  uuid: rich,
  cwd: messenger,
  title: '메신저처럼 다듬기',
  mtime: now - 12 * 60_000,
  records: [
    line({ type: 'user', uuid: 'u1', timestamp: iso(now - 40 * 60_000), cwd: messenger, message: { role: 'user', content: '승인 카드와 선택지를 분명하게. 도구 호출은 접어 두고, 코드는 읽기 쉽게.' } }),
    line({
      type: 'assistant', timestamp: iso(now - 39 * 60_000), cwd: messenger,
      message: {
        id: 'm1', model: 'claude-sonnet-4-5',
        usage: { input_tokens: 1200, cache_read_input_tokens: 82000, cache_creation_input_tokens: 400, output_tokens: 380 },
        content: [
          { type: 'thinking', thinking: '레이아웃부터 보고, 도구 결과는 접는다.' },
          { type: 'text', text: '허용은 한 번, 거부는 위험 동작으로 나누겠습니다. 먼저 스타일 파일을 봅니다.' },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'src/ui/styles.css' } },
        ],
      },
    }),
    line({ type: 'user', timestamp: iso(now - 38 * 60_000), cwd: messenger, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '/* tokens */\n:root { --bg: #14141c; }\n' }] } }),
    line({
      type: 'assistant', timestamp: iso(now - 37 * 60_000), cwd: messenger,
      message: {
        id: 'm2', model: 'claude-sonnet-4-5',
        usage: { input_tokens: 2400, cache_read_input_tokens: 84000, output_tokens: 220 },
        content: [
          { type: 'tool_use', id: 'tu2', name: 'Agent', input: { description: '스타일 토큰', subagent_type: 'explore', prompt: 'spacing rhythm' } },
          { type: 'tool_use', id: 'tu3', name: 'Bash', input: { command: 'git diff --stat' } },
        ],
      },
    }),
    line({ type: 'user', timestamp: iso(now - 36 * 60_000), cwd: messenger, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: '간격은 4/8/12, 말풍선 너비는 읽기 폭 안.' }] } }),
    line({ type: 'user', timestamp: iso(now - 36 * 60_000), cwd: messenger, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu3', content: ' src/ui/styles.css | 40 +-\n 1 file changed\n' }] } }),
    line({
      type: 'assistant', timestamp: iso(now - 20 * 60_000), cwd: messenger,
      message: {
        id: 'm3', model: 'claude-sonnet-4-5',
        usage: { input_tokens: 800, cache_read_input_tokens: 86000, output_tokens: 640 },
        content: [{
          type: 'text',
          text: [
            '본문은 한 칼럼에 두고, 도구는 한 줄로 접습니다.',
            '',
            '```css',
            '.msg.user pre {',
            '  max-width: min(78%, 520px);',
            '  border-radius: 18px 18px 6px 18px;',
            '}',
            '```',
            '',
            '```deck-choices',
            '? 다음에 무엇을 할까요?',
            '- 이어서 다듬기',
            '- 라이트 테마도 보기',
            '- 여기까지',
            '```',
          ].join('\n'),
        }],
      },
    }),
  ],
});

session({
  uuid: layout,
  cwd: messenger,
  title: '글자 크기 정리',
  mtime: now - 3 * 3_600_000,
  records: [
    line({ type: 'user', timestamp: iso(now - 3 * 3_600_000), cwd: messenger, message: { role: 'user', content: '본문은 한 스케일을 따릅니다. 글자 크기 설정이 전체를 움직이게.' } }),
    line({ type: 'assistant', timestamp: iso(now - 3 * 3_600_000 + 60_000), cwd: messenger, message: { id: 'm4', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: '`--fs-*` 와 `--font-scale` 만 본문 크기를 바꿉니다. 다른 곳의 px 글자는 치웁니다.' }] } }),
  ],
});

session({
  uuid: notesId,
  cwd: notes,
  title: '배포 점검',
  mtime: now - 26 * 3_600_000,
  records: [
    line({ type: 'user', timestamp: iso(now - 26 * 3_600_000), cwd: notes, message: { role: 'user', content: '빌드와 번들 한도를 확인해 줘.' } }),
    line({ type: 'assistant', timestamp: iso(now - 26 * 3_600_000 + 120_000), cwd: notes, message: { id: 'm5', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'Build passed. 청크는 500 kB 아래입니다. 경고 3개는 글꼴 파일입니다.' }] } }),
  ],
});

session({
  uuid: auto,
  cwd: messenger,
  title: '야간 로그 정리',
  mtime: now - 5 * 3_600_000,
  records: [
    line({ type: 'user', entrypoint: 'sdk-cli', timestamp: iso(now - 5 * 3_600_000), cwd: messenger, message: { role: 'user', content: '로그를 한 줄로 요약' } }),
    line({ type: 'assistant', entrypoint: 'sdk-cli', timestamp: iso(now - 5 * 3_600_000 + 30_000), cwd: messenger, message: { id: 'm6', model: 'claude-haiku-4-5', content: [{ type: 'text', text: '에러 0, 경고 2. 백그라운드 작업은 끝났습니다.' }] } }),
  ],
});

session({
  uuid: empty,
  cwd: notes,
  title: '빈 세션',
  mtime: now - 50 * 60_000,
  records: [],
});

const login = token();
fs.writeFileSync(path.join(configDir, 'token'), `${login}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(configDir, 'accounts.json'), JSON.stringify({
  version: 1,
  accounts: [{ id: 'a', label: 'A', configDir: profile }],
}, null, 2) + '\n');
fs.writeFileSync(path.join(configDir, 'pins.json'), JSON.stringify([rich]) + '\n');
fs.writeFileSync(path.join(configDir, 'session-icons.json'), JSON.stringify({ [rich]: 'glyph:hexagon' }) + '\n');
fs.writeFileSync(path.join(configDir, 'setup.json'), JSON.stringify({ state: 'done', doneAt: new Date(now).toISOString() }, null, 2) + '\n');
fs.writeFileSync(path.join(configDir, 'projects.json'), JSON.stringify([{ cwd: messenger, name: 'messenger' }, { cwd: notes, name: 'notes' }], null, 2) + '\n');

const url = `http://127.0.0.1:9320/#token=${login}`;
const stamp = path.join(root, 'demo.env');
const envText = [
  `DECK_CONFIG_DIR=${configDir}`,
  `DECK_HOME=${home}`,
  `DECK_EXTRA_CWD_ROOTS=${work}`,
  `DECK_DEV_ORIGIN=http://127.0.0.1:5173`,
  `MSG_DEMO_TOKEN=${login}`,
  `MSG_DEMO_URL=${url}`,
  `MSG_DEMO_VITE=http://127.0.0.1:5173/#token=${login}`,
  `MSG_DEMO_SESSION=${rich}`,
].join('\n') + '\n';
fs.writeFileSync(stamp, envText, { mode: 0o600 });
process.stdout.write(envText);
// Stable id for scripts that only need to know the seed ran.
process.stdout.write(`# sha ${createHash('sha256').update(login).digest('hex').slice(0, 12)}\n`);
