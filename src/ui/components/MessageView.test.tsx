// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MessageView } from './MessageView';

describe('MessageView', () => {
  afterEach(cleanup);

  it('renders markdown images as links, never as <img> (no auto-loading remote URLs)', () => {
    const { container } = render(<MessageView item={{ kind: 'assistant', turnId: 't', text: 'see ![pixel](https://evil.example/p.png?leak=1) here', toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    expect(container.querySelector('img')).toBeNull();
    const a = container.querySelector('a[href="https://evil.example/p.png?leak=1"]');
    expect(a).not.toBeNull();
    expect(a?.getAttribute('rel')).toBe('noreferrer noopener');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.textContent).toContain('pixel');
  });

  it('shows the role-distribution badge for subagent/offload calls and attachment chips on user messages', () => {
    const { container } = render(<MessageView item={{ kind: 'assistant', turnId: 't', text: 'done', toolCalls: [
      { toolUseId: '1', name: 'Agent', input: { subagent_type: 'explore', model: 'sonnet', description: 'find' }, result: 'ok', isError: false },
      { toolUseId: '2', name: 'Bash', input: { command: 'offload cross "x"' }, result: 'ok', isError: false },
    ], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    expect(container.querySelector('.role-badge')?.textContent).toContain('explore');
    expect(container.querySelector('.role-badge')?.textContent).toContain('offload cross');
    cleanup();
    const u = render(<MessageView item={{ kind: 'user', text: 'look', attachments: ['shot.png'] }} />);
    expect(u.container.querySelector('.chip')?.textContent).toBe('shot.png');
  });
});

describe('MessageView tool lines (Desktop style)', () => {
  afterEach(cleanup);
  const tc = (id: string, name: string, input: unknown, extra = {}) => ({ toolUseId: id, name, input, result: 'out', isError: false, ...extra });

  it('one tool call is one collapsed line; several are one collapsed group line that expands to per-call lines', () => {
    const one = render(<MessageView item={{ kind: 'assistant', turnId: 't', text: 'ok', toolCalls: [tc('1', 'Bash', { command: 'npm test', description: 'Run tests' })], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    const line = one.container.querySelector('[data-testid="tool-call"]') as HTMLDetailsElement;
    expect(line.querySelector('summary')?.textContent).toContain('Run tests');
    expect(line.open).toBe(false);
    expect(one.container.querySelector('.tool-group')).toBeNull();
    cleanup();
    const many = render(<MessageView item={{ kind: 'assistant', turnId: 't', text: '', toolCalls: [tc('1', 'Bash', { command: 'a' }), tc('2', 'Bash', { command: 'b' }, { isError: true })], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    const group = many.container.querySelector('[data-testid="tool-group"]') as HTMLDetailsElement;
    expect(group.querySelector('summary')?.textContent).toContain('실행된 명령 2개');
    expect(group.querySelector('summary')?.textContent).toContain('오류 1');
    expect(group.open).toBe(false);
    expect(group.querySelectorAll('[data-testid="tool-call"]')).toHaveLength(2);
    expect(many.container.querySelector('.markdown')).toBeNull();
  });

  it('a call without a result shows 실행 중 only while the turn streams', () => {
    const item = { kind: 'assistant' as const, turnId: 't', text: '', toolCalls: [{ toolUseId: '1', name: 'Read', input: { file_path: '/w/x.ts' }, result: null, isError: false }], badge: null, streaming: true, error: null, notes: [], attempts: [] };
    const live = render(<MessageView item={item} />);
    expect(live.container.querySelector('.tool-call.running')?.textContent).toContain('실행 중');
    cleanup();
    const done = render(<MessageView item={{ ...item, streaming: false }} />);
    expect(done.container.querySelector('.tool-call')?.textContent).not.toContain('실행 중');
  });
});
