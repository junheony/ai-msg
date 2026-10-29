// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { DeckMark } from './DeckMark';
import { Login } from './Login';

afterEach(cleanup);

describe('DeckMark', () => {
  it('is the app icon chip as SVG — a purple rounded square with the white speech-bubble cube — and no text', () => {
    const { container } = render(<DeckMark className="spark" />);
    const svg = container.querySelector('svg.deck-mark.spark');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
    const rect = svg!.querySelector('rect');
    expect(rect?.getAttribute('rx')).toBe('6.3');
    expect(rect?.getAttribute('fill')).toMatch(/^url\(#/);
    const stops = [...svg!.querySelectorAll('stop')].map((s) => s.getAttribute('stop-color'));
    expect(stops).toEqual(['#6366f1', '#4338ca']);
    const fills = [...svg!.querySelectorAll('path')].map((p) => p.getAttribute('fill'));
    expect(fills).toEqual(['#ffffff', '#e0e7ff', '#a5b4fc']);
    expect(container.textContent).toBe('');
  });

  it('two marks on one page keep separate gradient ids', () => {
    const { container } = render(<><DeckMark className="a" /><DeckMark className="b" /></>);
    const ids = [...container.querySelectorAll('linearGradient')].map((g) => g.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(container.querySelector('svg.a rect')?.getAttribute('fill')).toBe(`url(#${ids[0]})`);
  });

  it('is the brand mark on the login (the Claude star stays with sessions)', () => {
    const { container } = render(<Login onLoggedIn={() => {}} />);
    expect(container.querySelector('h1 svg.deck-mark')).not.toBeNull();
    expect(container.querySelector('h1 svg.claude-mark')).toBeNull();
    expect(container.querySelector('h1')?.textContent).toBe('MSG');
  });
});
