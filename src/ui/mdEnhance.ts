import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';

/**
 * Syntax highlighting (highlight.js common languages) and math (KaTeX). Loaded on demand by MessageView
 * (dynamic import) so a chat without code or formulas never downloads them.
 */
/**
 * Math: `$$…$$` (remark-math) and LaTeX's `\(…\)` inline / `\[…\]` display. Single-$ stays off: prices, $TICKERs and
 * shell `$HOME` are everywhere in chat, and no rule tells `($TSLA)와 ($AAPL)` from math.
 * Markdown reads `\(` as an escaped `(`, so the text node no longer has the backslash: the delimiters are found in the
 * source (node.position offsets), and the formula is the source between them, as written (`\{` keeps its backslash).
 * A delimiter pair split by other markup (emphasis, a link) is left as text; code is never a text node.
 */
type MdNode = { type: string; value?: string; children?: MdNode[]; data?: Record<string, unknown>; position?: { start: { offset?: number }; end: { offset?: number } } };

const ESCAPABLE = /[!-/:-@[-`{-~]/;

function texNode(value: string, display: boolean): MdNode {
  const className = ['language-math', display ? 'math-display' : 'math-inline'];
  return { type: 'inlineMath', value, data: { hName: 'code', hProperties: { className }, hChildren: [{ type: 'text', value }] } };
}

function splitTex(text: MdNode, source: string, first: boolean, lastChild: boolean): MdNode[] {
  const from = text.position?.start.offset;
  const to = text.position?.end.offset;
  if (from === undefined || to === undefined) return [text];
  const raw = source.slice(from, to);
  if (!raw.includes('\\(') && !raw.includes('\\[')) return [text];
  // Rebuild the node's value from its source, noting for each character where it sits and whether it was escaped.
  const at: number[] = [];
  const esc: boolean[] = [];
  let value = '';
  const want = text.value ?? '';
  for (let r = 0; r < raw.length; r++) {
    // A continuation line's indent (list item, blockquote-free paragraph) is in the source, not in the value.
    if ((raw[r] === ' ' || raw[r] === '\t') && value.endsWith('\n') && want[value.length] !== raw[r]) continue;
    const escaped = raw[r] === '\\' && r + 1 < raw.length && ESCAPABLE.test(raw[r + 1]!);
    if (escaped) r++;
    at.push(r);
    esc.push(escaped);
    value += raw[r];
  }
  if (value !== want) return [text]; // entities, a blockquote's `>`: the mapping is off, leave it alone
  // `\[` opens a line and `\]` ends one (only spaces around), so `결과\[1\]` and `\[x\] 완료` stay brackets. At the
  // node's edge the line goes on in a sibling (emphasis, a link) unless the node is its paragraph's first / last child.
  const lineOpens = (i: number) => /(^|\n)[ \t]*$/.test(value.slice(0, i)) && (first || value.slice(0, i).includes('\n'));
  const lineEnds = (j: number) => /^[ \t]*(\n|$)/.test(value.slice(j + 1)) && (lastChild || value.slice(j + 1).includes('\n'));
  const out: MdNode[] = [];
  let last = 0;
  for (let i = 0; i < value.length; i++) {
    const open = value[i];
    if (!esc[i] || (open !== '(' && open !== '[')) continue;
    const display = open === '[';
    if (display && !lineOpens(i)) continue;
    const close = display ? ']' : ')';
    let j = i + 1;
    while (j < value.length && !(esc[j] && value[j] === close && (!display || lineEnds(j)))) j++;
    if (j >= value.length) continue; // unclosed (still streaming): text
    const tex = raw.slice(at[i]! + 1, at[j]! - 1);
    // `\( x \)` with space inside reads as prose about parentheses (`\(와 \)는 괄호`), not a formula.
    if (!tex.trim() || (!display && tex !== tex.trim())) continue;
    if (i > last) out.push({ type: 'text', value: value.slice(last, i) });
    out.push(texNode(tex.trim(), display));
    last = j + 1;
    i = j;
  }
  if (last === 0) return [text];
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

function walkTex(node: MdNode, source: string): void {
  if (!node.children) return;
  const n = node.children.length;
  node.children = node.children.flatMap((child, k) => {
    if (child.type === 'text') return splitTex(child, source, k === 0, k === n - 1);
    walkTex(child, source);
    return [child];
  });
}

const remarkTexDelimiters = () => (tree: MdNode, file: { value?: unknown }) => walkTex(tree, String(file.value ?? ''));

export const REMARK_ENHANCE = [[remarkMath, { singleDollarTextMath: false }], remarkTexDelimiters] as never[];
/** No `maxExpand`: KaTeX's own limit (1000) is finite, and a lower one breaks ordinary blocks (a dozen `\implies`). */
export const KATEX_OPTIONS = { throwOnError: false, strict: 'ignore', maxSize: 20 } as const;
export const REHYPE_ENHANCE = [[rehypeHighlight, { detect: false }], [rehypeKatex, KATEX_OPTIONS]] as never[];
