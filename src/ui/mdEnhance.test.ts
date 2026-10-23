import { describe, expect, it } from 'vitest';
import katex from 'katex';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { KATEX_OPTIONS, REHYPE_ENHANCE, REMARK_ENHANCE } from './mdEnhance';

/** Rendered the way rehype-katex does for a `$$` block, with the options mdEnhance hands it. */
const render = (tex: string) => katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: true });

describe('mdEnhance: KaTeX options', () => {
  it('an ordinary long block renders: 30 lines of \\implies and \\neq stay under the expansion limit', () => {
    const tex = `\\begin{aligned}${Array.from({ length: 30 }, (_, n) => `a_{${n}} &\\implies b_{${n}} \\neq c_{${n}}`).join(' \\\\ ')}\\end{aligned}`;
    const html = render(tex);
    expect(html).not.toContain('katex-error');
    expect(html.match(/⟹/g)?.length).toBeGreaterThanOrEqual(30);
  });

  it('an oversized box is cut to maxSize', () => {
    const html = render('\\rule{500em}{500em}');
    expect(html).not.toContain('katex-error');
    // The source stays in the MathML annotation; the drawn box is what is cut.
    expect(html).not.toMatch(/(width|height)[:=]"?500em/);
    expect(html).toContain(`border-right-width:${KATEX_OPTIONS.maxSize}em;border-top-width:${KATEX_OPTIONS.maxSize}em`);
  });

  it('runaway macro expansion still ends in an error, not a hang', () => {
    expect(render('\\def\\x{\\x\\x}\\x')).toContain('katex-error');
  });
});

/** Markdown → HTML through the same remark/rehype plugins MessageView hands react-markdown. */
const html = (md: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, ...REMARK_ENHANCE], rehypePlugins: REHYPE_ENHANCE }, md));
const hasMath = (md: string) => html(md).includes('class="katex"');

describe('mdEnhance: inline $…$ math', () => {
  it('prices stay text', () => {
    for (const md of ['It costs $5 and $10.', '$5-$10 a month', 'between $5/$10', '$TSLA and $AAPL', '가격은 $5이고 할인하면 $3이에요', 'Pay $ 5 or $ 6']) {
      expect(hasMath(md), md).toBe(false);
      expect(html(md), md).toContain('$');
    }
  });

  it('$…$ with tight delimiters renders, inside text and next to Korean', () => {
    expect(hasMath('수식도 하나: $E = mc^2$')).toBe(true);
    expect(hasMath('$x$를 구하면')).toBe(true);
    expect(hasMath('escaped $\\{a\\}$ braces')).toBe(true);
    expect(html('a $x^2$ b $y$ c').match(/class="katex"/g)).toHaveLength(2);
  });

  it('$$…$$ still renders; $ in code stays code', () => {
    expect(hasMath('$$a+b$$')).toBe(true);
    expect(hasMath('run `echo $HOME $PATH$`')).toBe(false);
    expect(hasMath('```sh\necho $x$\n```')).toBe(false);
  });
});
