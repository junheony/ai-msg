// R2-B fixture body: sample tool calls rendered by the real ToolCallView (Claude / Codex / Grok names, an error, long and
// server-cut output, a diff). Regenerate the part of scripts/render/tool-calls.html between its BODY markers with
//   npx tsx scripts/render/tool-calls.gen.ts [ko|en]
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLocale } from '../../src/shared/locale';
import { ToolCallView } from '../../src/ui/components/ToolCallView';
import type { ToolCallItem } from '../../src/ui/state';

setLocale((process.argv[2] as 'ko' | 'en') ?? 'ko');
const cwd = '/work/deck';
const long = Array.from({ length: 60 }, (_, i) => `src/ui/components/File${i}.tsx: ${'x'.repeat(i % 7 * 9)} line ${i + 1}`).join('\n');
const calls: [string, ToolCallItem][] = [
  ['Bash (Claude) 성공', { toolUseId: 'a', name: 'Bash', input: { command: 'git status --short && npx tsc --noEmit -p . --pretty false 2>&1 | head -40', description: 'Typecheck the project' }, result: ' M src/ui/styles.css\n?? .omc/', isError: false }],
  ['Bash 실패 (종료 코드)', { toolUseId: 'b', name: 'Bash', input: { command: 'npx vitest run src/ui/diff.test.ts' }, result: 'Exit code 1\n FAIL  src/ui/diff.test.ts > relPath > keeps outside paths\nAssertionError: expected \'/tmp/x\' to be \'x\'\n Test Files  1 failed (1)', isError: true }],
  ['Bash 긴 출력', { toolUseId: 'c', name: 'Bash', input: { command: 'rg -n "line" src/ui/components' }, result: long, isError: false }],
  ['서버에서 잘린 출력', { toolUseId: 'd', name: 'Bash', input: { command: 'cat build.log' }, result: `${long}\n…[잘림: 원래 48211자]`, isError: false }],
  ['Read', { toolUseId: 'e', name: 'Read', input: { file_path: `${cwd}/src/ui/components/ToolCallView.tsx`, offset: 40, limit: 80 }, result: '40\timport x\n41\tconst y = 1;', isError: false }],
  ['Grep', { toolUseId: 'f', name: 'Grep', input: { pattern: 'tool-output', path: `${cwd}/src/ui`, glob: '*.css', output_mode: 'content', '-n': true }, result: 'src/ui/styles.css:394:.tool-input, .tool-output {', isError: false }],
  ['Grok 명령', { toolUseId: 'g', name: 'grok:run_terminal_command', input: { variant: 'Bash', command: 'printf hi > b.txt', description: 'Write hi to b.txt', is_background: false }, result: 'exit: 0\n', isError: false }],
  ['MCP 도구', { toolUseId: 'h', name: 'mcp__deck_bridge__permission', input: { tool_name: 'Bash', input: { command: 'rm -rf build' }, reason: 'clean build output' }, result: '{"behavior":"allow"}', isError: false }],
  ['Edit (diff)', { toolUseId: 'i', name: 'Edit', input: { file_path: `${cwd}/src/ui/styles.css`, old_string: '.tool-input, .tool-output { padding: 10px 12px; max-height: 260px; overflow: auto; color: var(--fg); }', new_string: '.tool-input, .tool-output { padding: var(--s2) var(--s3); max-height: none; overflow: auto; color: var(--fg); white-space: pre-wrap; overflow-wrap: anywhere; }\n.tool-out-note { color: var(--faint); }' }, result: 'The file has been updated.', isError: false }],
];
const body = calls.map(([label, c]) => `<div class="fx-name">${label}</div>\n<div class="msg assistant">${renderToStaticMarkup(createElement(ToolCallView, { call: c, cwd }))}</div>`).join('\n');
process.stdout.write(body);
