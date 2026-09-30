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
