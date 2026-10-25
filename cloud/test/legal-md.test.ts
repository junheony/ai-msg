import { describe, expect, it } from 'vitest';
import { LegalSyntaxError, renderLegal } from '../scripts/legal-md.mjs';
import { LEGAL, LEGAL_DRAFT } from '../src/legal/pages.gen';

const links = { 'terms.md': '/legal/terms', 'privacy.md': '/legal/privacy' };

describe('renderLegal', () => {
  it('renders the supported subset and escapes text', () => {
    const r = renderLegal('# T\n\n- **a** & `b`\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\nSee [Privacy](privacy.md).', { strict: false, links });
    expect(r.title).toBe('T');
    expect(r.html).toContain('<strong>a</strong> &amp; <code>b</code>');
    expect(r.html).toContain('<table>');
    expect(r.html).toContain('<th>x</th>');
    expect(r.html).toContain('<td>2</td>');
    expect(r.html).toContain('href="/legal/privacy"');
    expect(r.placeholders).toEqual([]);
  });

  it('headings, quotes, numbered lists, mailto and https links', () => {
    const r = renderLegal('# T\n\n## Two\n\n### Three\n\n> quoted\n> more\n\n1. one\n2. two\n\n[m](mailto:x@example.test) [w](https://example.test/a?b=1&c=2)', { strict: false, links });
    expect(r.html).toContain('<h2>Two</h2>');
    expect(r.html).toContain('<h3>Three</h3>');
    expect(r.html).toContain('<blockquote><p>quoted<br>more</p></blockquote>');
    expect(r.html).toContain('<ol><li>one</li><li>two</li></ol>');
    expect(r.html).toContain('href="mailto:x@example.test"');
    expect(r.html).toContain('href="https://example.test/a?b=1&amp;c=2"');
  });

  it.each(['<b>x</b>', '![i](x.png)', '```\ncode\n```', '- a\n  - nested', '*it*', '_it_', 'note[^1]', '[x](javascript:alert(1))', '[x](other.md)'])(
    'rejects unsupported syntax: %s',
    (md) => { expect(() => renderLegal(md, { strict: false, links })).toThrow(LegalSyntaxError); },
  );

  it('the error names the line', () => {
    try {
      renderLegal('# T\n\nfine\n\n<i>bad</i>', { strict: false, links });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LegalSyntaxError);
      expect((e as LegalSyntaxError).line).toBe(5);
    }
  });

  it('underscores and stars inside code are text', () => {
    expect(renderLegal('Use `snake_case` and `a*b`.', { strict: false, links }).html).toContain('<code>snake_case</code>');
  });

  it('placeholders: marked when not strict, fatal when strict', () => {
    const r = renderLegal('Date `{{EFFECTIVE_DATE}}` and {{확인 필요: x}}', { strict: false, links });
    expect(r.html).toContain('<mark class="todo">');
    expect(r.placeholders).toEqual(['{{EFFECTIVE_DATE}}', '{{확인 필요: x}}']);
    expect(() => renderLegal('Date {{EFFECTIVE_DATE}}', { strict: true, links })).toThrow();
    expect(() => renderLegal('> **DRAFT. Not legal advice.**', { strict: true, links })).toThrow();
    expect(() => renderLegal('> In force.', { strict: true, links })).not.toThrow();
  });
});

describe('generated pages', () => {
  it('the real drafts build in non-strict mode', () => {
    for (const doc of ['terms', 'privacy', 'refund'] as const) {
      for (const lang of ['en', 'ko'] as const) {
        expect(LEGAL[doc][lang].title.length).toBeGreaterThan(0);
        expect(LEGAL[doc][lang].html).toContain('<h2>');
        expect(LEGAL[doc][lang].html).not.toMatch(/<script|\son\w+=/i);
      }
    }
    expect(LEGAL_DRAFT).toBe(true);
  });
});
