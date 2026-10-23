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

describe('mdEnhance: math delimiters', () => {
  it('single $ never makes math: prices, tickers, shell variables stay text', () => {
    const texts = [
      'It costs $5 and $10.', '$5-$10 a month', 'between $5/$10', '$TSLA and $AAPL', '가격은 $5이고 할인하면 $3이에요', 'Pay $ 5 or $ 6',
      '테슬라($TSLA)와 애플($AAPL)', '$TSLA/$AAPL', '$NVDA·$AMD', 'export PATH=$HOME/bin:$PATH', 'echo $a$b', '가격 $5,000~$',
      '수식처럼 보여도 $E = mc^2$ 는 글자',
    ];
    for (const md of texts) {
      expect(hasMath(md), md).toBe(false);
      expect(html(md), md).toContain('$');
    }
  });

  it('$$…$$ renders, inline and as a block', () => {
    expect(hasMath('식 $$a+b$$ 끝')).toBe(true);
    expect(html('$$\na^2\n$$')).toContain('katex-display');
  });

  it('\\(…\\) renders inline and \\[…\\] as a block, with the formula as written', () => {
    const inline = html('에너지는 \\(E = mc^2\\) 이고 \\(\\{x\\}\\) 집합');
    expect(inline.match(/class="katex"/g)).toHaveLength(2);
    expect(inline).not.toContain('katex-display');
    expect(inline).not.toContain('katex-error');
    expect(inline).toContain('<annotation encoding="application/x-tex">\\{x\\}</annotation>');
    expect(html('\\[\n\\frac{a}{b}\n\\]')).toContain('katex-display');
  });

  it('escaped brackets mid-line and \\( … \\) with spaces inside stay text', () => {
    for (const md of ['논문 결과\\[1\\]와 \\[2\\]', '체크 \\[x\\] 완료', '\\[x\\] 완료', '앞 \\[\na\n\\]', '\\[\na\n\\] 뒤', '정규식에서 \\(와 \\)는 괄호', '\\( x \\)', '결과 **\\[1\\]** 와 끝', '체크 *\\[x\\]* 완료', 'see [\\[1\\]](https://x.test) now']) {
      expect(hasMath(md), md).toBe(false);
    }
    expect(hasMath('  \\[ a+b \\]  ')).toBe(true);
    expect(hasMath('- 항목\n\n  \\[\n  x\n  \\]')).toBe(true);
  });

  it('an escaped backslash, an unclosed \\( and code stay text', () => {
    expect(hasMath('\\\\(not math\\\\)')).toBe(false);
    expect(hasMath('streaming \\(x + ')).toBe(false);
    expect(hasMath('run `echo \\(x\\)` and `$$y$$`')).toBe(false);
    expect(hasMath('```sh\necho \\(x\\) $$y$$\n```')).toBe(false);
  });
});

