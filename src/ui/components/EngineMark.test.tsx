// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { EngineBadge, EngineMark, engineOf } from './EngineMark';

afterEach(cleanup);

describe('engine badges (our letters, no vendor logos)', () => {
  it.each([
    ['claude', 'C', 'Claude'],
    ['codex', 'G', 'Codex (GPT)'],
    ['gemini', 'Gm', 'Gemini'],
    ['grok', 'X', 'Grok'],
  ] as const)('%s: the letter %s in one badge shape, named %s, no SVG and no text in the title', (engine, letter, name) => {
    const { container } = render(<EngineMark engine={engine} />);
    const mark = container.querySelector(`.engine-mark.${engine}`)!;
    expect(mark.getAttribute('role')).toBe('img');
    expect(mark.getAttribute('aria-label')).toBe(name);
    expect(mark.getAttribute('title')).toBe(name);
    const badge = mark.querySelector('.engine-badge')!;
    expect(badge.getAttribute('data-letter')).toBe(letter);
    expect(badge.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('decorative marks hide from assistive tech', () => {
    const { container } = render(<EngineMark engine="codex" decorative />);
    expect(container.querySelector('.engine-mark.codex')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('a bare badge takes the caller class; two-letter badges are marked wide', () => {
    const { container } = render(<><EngineBadge engine="gemini" className="usage-mark" /><EngineBadge engine="claude" /></>);
    expect(container.querySelector('.engine-badge.gemini.wide.usage-mark')).not.toBeNull();
    expect(container.querySelector('.engine-badge.claude.wide')).toBeNull();
  });

  it('engineOf: its own field, else the seat (x1 → Grok, gpt → Codex)', () => {
    expect(engineOf({ account: 'x1' })).toBe('grok');
    expect(engineOf({ account: 'gpt' })).toBe('codex');
    expect(engineOf({ engine: 'grok', account: 'a' })).toBe('grok');
  });
});
