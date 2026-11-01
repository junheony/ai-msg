// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ClaudeMark, EngineMark, engineOf } from './EngineMark';

afterEach(cleanup);

describe('ClaudeMark', () => {
  it('is an SVG star in #D97757 with no text (a ✳ glyph renders as a green emoji on some systems)', () => {
    const { container } = render(<><EngineMark engine="claude" /><ClaudeMark className="spark" /></>);
    const marks = container.querySelectorAll('svg.claude-mark');
    expect(marks).toHaveLength(2);
    expect(container.querySelector('.engine-mark.claude svg.engine-mark-svg')).not.toBeNull();
    for (const m of marks) {
      expect(m.querySelectorAll('line').length).toBeGreaterThanOrEqual(8);
      expect(m.querySelector('g')?.getAttribute('stroke')).toBe('#D97757');
    }
    expect(container.textContent).toBe('');
  });
});

describe('Grok mark', () => {
  it('a Grok session gets its own SVG mark (no text); the x1 seat implies Grok', () => {
    const { container } = render(<EngineMark engine="grok" />);
    expect(container.querySelector('.engine-mark.grok svg.grok-mark')).not.toBeNull();
    expect(container.querySelector('.engine-mark.grok')?.getAttribute('aria-label')).toBe('Grok');
    expect(container.textContent).toBe('');
    expect(engineOf({ account: 'x1' })).toBe('grok');
    expect(engineOf({ engine: 'grok', account: 'a' })).toBe('grok');
  });
});


describe('Hermes and Gemini identities', () => {
  it('gives each engine its own accessible inline mark and respects an explicit Hermes engine', () => {
    const { container } = render(<><EngineMark engine="hermes" /><EngineMark engine="gemini" /></>);
    expect(container.querySelector('.engine-mark.hermes svg.hermes-mark')).not.toBeNull();
    expect(container.querySelector('[aria-label="Hermes"]')).not.toBeNull();
    expect(container.querySelector('.engine-mark.gemini svg.gemini-mark')).not.toBeNull();
    expect(engineOf({ engine: 'hermes', account: 'gpt' })).toBe('hermes');
    expect(engineOf({ account: 'hermes' })).toBe('hermes');
  });
});
