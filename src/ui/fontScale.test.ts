import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const cssPath = join(__dirname, 'styles.css');
const css = readFileSync(cssPath, 'utf8');
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

type Decl = { selector: string; value: string };

/** font-size declarations outside comments, with the rule's selector. */
function fontSizes(source: string): Decl[] {
  const out: Decl[] = [];
  const re = /font-size\s*:/g;
  for (const m of source.matchAll(re)) {
    const start = m.index! + m[0].length;
    const end = source.indexOf(';', start);
    const brace = source.lastIndexOf('{', m.index!);
    let i = brace - 1;
    while (i >= 0 && source[i] !== '}' && source[i] !== '{') i--;
    const selector = source.slice(i + 1, brace).replace(/\s+/g, ' ').trim();
    out.push({ selector, value: source.slice(start, end).trim().replace(/\s+/g, ' ') });
  }
  return out;
}

function hasCode(selector: string): boolean {
  return /(^|[^\w-])code([^\w-]|$)/.test(selector);
}

/** A declaration follows the scale, or is one of the two allowed exceptions. */
function followsScale(d: Decl): boolean {
  const v = d.value;
  if (v === 'inherit') return true;
  if (/^[\d.]+(?:em|rem)$/.test(v) && hasCode(d.selector)) return true;
  // Session-icon glyphs are a fraction of the circle (--av-size), not reading text.
  // Growing them with --font-scale would overflow the 28px (32px on a phone) mark.
  if (/^calc\(var\(--av-size\) \* \.?\d+\)$/.test(v)) return true;
  if (!v.includes('var(--fs-')) return false;
  // The token already includes --font-scale. Multiplying again would double it.
  if (/var\(--font-scale/.test(v)) return false;
  return true;
}

function mediaBodies(source: string, header: RegExp): string[] {
  const out: string[] = [];
  const re = /@media[^{]*\{/g;
  for (const m of source.matchAll(re)) {
    if (!header.test(m[0])) continue;
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    out.push(source.slice(start, i - 1));
  }
  return out;
}

const decls = fontSizes(stripped);

describe('type scale', () => {
  it('defines each step as calc(Npx * var(--font-scale)) and keeps the old names as aliases', () => {
    const root = stripped.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    for (const [name, px] of [['2xs', 11], ['xs', 12], ['sm', 13], ['md', 14], ['base', 15], ['lg', 17], ['xl', 22], ['display', 28]] as const) {
      expect(root).toContain(`--fs-${name}: calc(${px}px * var(--font-scale, 1))`);
    }
    expect(root).toContain('--fs-title: var(--fs-lg)');
    expect(root).toContain('--fs-body: var(--fs-base)');
    expect(root).toContain('--fs-label: var(--fs-sm)');
    expect(root).toContain('--fs-meta: var(--fs-xs)');
    expect(root).toContain('--fs-mono: var(--fs-sm)');
    expect(root).toContain('--lh-tight: 1.25');
    expect(root).toContain('--lh-normal: 1.5');
    expect(root).toContain('--lh-relaxed: 1.65');
  });

  it('every font-size uses var(--fs-*) except inherit, em inside code, and session-icon glyphs', () => {
    const bad = decls.filter((d) => !followsScale(d));
    expect(bad).toEqual([]);
    expect(decls.length).toBeGreaterThan(300);
  });

  it('mobile (max-width: 720px) rules use the same scale', () => {
    const bodies = mediaBodies(stripped, /max-width:\s*720px/);
    expect(bodies.length).toBeGreaterThan(0);
    const mobile = bodies.flatMap(fontSizes);
    expect(mobile.length).toBeGreaterThan(0);
    expect(mobile.filter((d) => !followsScale(d))).toEqual([]);
  });

  it('markdown headings are defined once: h1 is xl, h2 and h3 are lg', () => {
    const of = (selector: string) => decls.filter((d) => d.selector === selector);
    expect(of('.markdown h1').map((d) => d.value)).toEqual(['var(--fs-xl)']);
    expect(of('.markdown h2').map((d) => d.value)).toEqual(['var(--fs-lg)']);
    expect(of('.markdown h3').map((d) => d.value)).toEqual(['var(--fs-lg)']);
    expect(of('.markdown h4, .markdown h5, .markdown h6').map((d) => d.value)).toEqual(['var(--fs-base)']);
    expect(stripped).toMatch(/\.markdown h1, \.markdown h2, \.markdown h3, \.markdown h4, \.markdown h5, \.markdown h6 \{[^}]*line-height:\s*var\(--lh-tight\)/);
    expect(stripped).toMatch(/\.markdown \{[^}]*font-size:\s*var\(--fs-base\)[^}]*line-height:\s*var\(--lh-relaxed\)/);
  });

  it('the sidebar session title is the 14px step, smaller than body', () => {
    const titles = decls.filter((d) => d.selector === '.session-title' || d.selector === '.session-rename');
    expect(titles.map((d) => d.value)).toEqual(['var(--fs-md)', 'var(--fs-md)']);
    const others = decls.filter((d) => d.value.includes('--fs-md') && d.selector !== '.session-title' && d.selector !== '.session-rename');
    expect(others).toEqual([]);
  });

  it('TSX does not set a font size inline', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.tsx')) files.push(p);
      }
    };
    walk(__dirname);
    const hits = files.filter((f) => /fontSize\s*:|font-size\s*:/.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
