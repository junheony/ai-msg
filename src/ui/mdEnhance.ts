import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';

/**
 * Syntax highlighting (highlight.js common languages) and math (KaTeX). Loaded on demand by MessageView
 * (dynamic import) so a chat without code or formulas never downloads them.
 */
/**
 * Inline `$…$` math, by Pandoc's rule so prices and $TICKERs stay text: the opening `$` has a non-space right after it,
 * the closing `$` a non-space right before it and no digit right after it ("$5 and $10" is two prices, "$E = mc^2$" is
 * math). remark-math's own single-$ parsing has no such rule, so it stays off and this pass turns matching text into
 * the same inlineMath node it would have made. Code is never a text node, so `$` in code is untouched.
 */
export const INLINE_MATH = /(?<![\\$])\$(?=[^\s$])((?:[^$\n\\]|\\.)*?(?:[^\s$\\]|\\.))\$(?![\d$])/g;

type MdNode = { type: string; value?: string; children?: MdNode[]; data?: Record<string, unknown> };

function inlineMath(value: string): MdNode {
  return { type: 'inlineMath', value, data: { hName: 'code', hProperties: { className: ['language-math', 'math-inline'] }, hChildren: [{ type: 'text', value }] } };
}

function splitMath(node: MdNode): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child): MdNode[] => {
    if (child.type !== 'text') { splitMath(child); return [child]; }
    const text = child.value ?? '';
    const out: MdNode[] = [];
    let last = 0;
    for (const m of text.matchAll(INLINE_MATH)) {
      if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
      out.push(inlineMath(m[1]!));
      last = m.index + m[0].length;
    }
    if (last === 0) return [child];
    if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
    return out;
  });
}

const remarkInlineMath = () => (tree: MdNode) => splitMath(tree);

// remark-math still parses `$$…$$` (display or inline); single-$ is ours (above).
export const REMARK_ENHANCE = [[remarkMath, { singleDollarTextMath: false }], remarkInlineMath] as never[];
/** No `maxExpand`: KaTeX's own limit (1000) is finite, and a lower one breaks ordinary blocks (a dozen `\implies`). */
export const KATEX_OPTIONS = { throwOnError: false, strict: 'ignore', maxSize: 20 } as const;
export const REHYPE_ENHANCE = [[rehypeHighlight, { detect: false }], [rehypeKatex, KATEX_OPTIONS]] as never[];
