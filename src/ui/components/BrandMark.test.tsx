// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { BrandMark, BrandWordmark, ProgressMark } from './BrandMark';
import { Login } from './Login';

afterEach(cleanup);

describe('BrandMark', () => {
  it('is the crystal-grain speech mark: three facets, themed by class, decorative, no text', () => {
    const { container } = render(<BrandMark className="spark" />);
    const svg = container.querySelector('svg.brand-mark.spark');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
    expect([...svg!.querySelectorAll('path')].map((p) => p.getAttribute('class'))).toEqual(['brand-top', 'brand-left', 'brand-right']);
    expect(container.textContent).toBe('');
  });

  it('the wordmark reads AI-MSG with MSG as its own (emphasised) span', () => {
    const { container } = render(<BrandWordmark />);
    expect(container.textContent).toBe('AI-MSG');
    expect(container.querySelector('.brand-msg')?.textContent).toBe('MSG');
  });

  it('the progress mark is neutral (currentColor, no engine mark) and decorative', () => {
    const { container } = render(<ProgressMark className="spark spin" />);
    const svg = container.querySelector('svg.progress-mark.spin')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    for (const p of svg.querySelectorAll('path')) expect(p.getAttribute('fill')).toBe('currentColor');
  });

  it('is the brand on the login', () => {
    const { container } = render(<Login onLoggedIn={() => {}} />);
    expect(container.querySelector('h1 svg.brand-mark')).not.toBeNull();
    expect(container.querySelector('h1')?.textContent).toBe('AI-MSG');
  });
});
