import { describe, expect, it } from 'vitest';
import { DEFAULT_TASK_SOFT_CAP, clampTaskCap, parseBgCommand, taskLine, taskTitle, tasksForPane, type TaskInfo } from './tasks';

const t = (p: Partial<TaskInfo>): TaskInfo => ({ taskId: 'x', fromSessionId: null, cwd: '/w', title: 't', status: 'running', sessionId: null, createdAt: 0, ...p });

describe('shared/tasks', () => {
  it('/bg takes the rest of the message, nothing else is one', () => {
    expect(parseBgCommand('/bg 테스트 고쳐줘')).toBe('테스트 고쳐줘');
    expect(parseBgCommand('  /bg  여러\n줄  ')).toBe('여러\n줄');
    expect(parseBgCommand('/bg')).toBeNull();
    expect(parseBgCommand('/bgx 뭐')).toBeNull();
    expect(parseBgCommand('그냥 /bg 말')).toBeNull();
  });
  it('title is the first line, clipped; line skips headings, bullets and code', () => {
    expect(taskTitle('\n\n  로그인 버그 고쳐줘\n자세히')).toBe('로그인 버그 고쳐줘');
    expect(taskTitle('가'.repeat(100))).toHaveLength(60);
    expect(taskLine('```\ncode\n```\n## 결과\n- 고쳤습니다')).toBe('결과');
    expect(taskLine('')).toBe('');
  });
  it('pane tasks: by originating session, or by folder for a new chat; newest first', () => {
    const list = [t({ taskId: '1', fromSessionId: 's', createdAt: 1 }), t({ taskId: '2', fromSessionId: 's', createdAt: 2 }), t({ taskId: '3', fromSessionId: 'other' }), t({ taskId: '4', cwd: '/w' }), t({ taskId: '5', cwd: '/v' })];
    expect(tasksForPane(list, 's', '/w').map((x) => x.taskId)).toEqual(['2', '1']);
    expect(tasksForPane(list, null, '/w').map((x) => x.taskId)).toEqual(['4']);
    expect(tasksForPane(list, null, null)).toEqual([]);
  });
  it('cap is clamped to 1–10, default 3', () => {
    expect(clampTaskCap(5)).toBe(5);
    expect(clampTaskCap(0)).toBe(DEFAULT_TASK_SOFT_CAP);
    expect(clampTaskCap(11)).toBe(DEFAULT_TASK_SOFT_CAP);
    expect(clampTaskCap('3')).toBe(DEFAULT_TASK_SOFT_CAP);
  });
});
