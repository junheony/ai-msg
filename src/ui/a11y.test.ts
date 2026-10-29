import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.join(process.cwd(), 'src/ui/styles.css'), 'utf8');

describe('accessibility baseline', () => {
  it('prefers-reduced-motion stops the message fade and every other animation', () => {
    expect(css).toMatch(/\.chat-body > \.msg \{ animation: msg-in /);
    const reduced = css.slice(css.indexOf('/* === reduced motion ==='));
    expect(reduced).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important; transition: none !important; scroll-behavior: auto !important; \}/);
  });

  it('keyboard focus is visible on controls, including the sidebar search field', () => {
    expect(css).toMatch(/button:focus-visible, select:focus-visible, input:focus-visible/);
    expect(css).toMatch(/\.sidebar-search:focus-within \{ box-shadow: var\(--focus\); \}/);
  });
});
