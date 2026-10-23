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

function splitTex(text: MdNode, source: string): MdNode[] {
  const from = text.position?.start.offset;
  const to = text.position?.end.offset;
  if (from === undefined || to === undefined) return [text];
  const raw = source.slice(from, to);
  if (!raw.includes('\\(') && !raw.includes('\\[')) return [text];
  // Rebuild the node's value from its source, noting for each character where it sits and whether it was escaped.
  const at: number[] = [];
  const esc: boolean[] = [];
  let value = '';
  for (let r = 0; r < raw.length; r++) {
    const escaped = raw[r] === '\\' && r + 1 < raw.length && ESCAPABLE.test(raw[r + 1]!);
    if (escaped) r++;
    at.push(r);
    esc.push(escaped);
    value += raw[r];
  }
  if (value !== text.value) return [text]; // entities, stripped indents: the mapping is off, leave it alone
  const out: MdNode[] = [];
  let last = 0;
  for (let i = 0; i < value.length; i++) {
    const open = value[i];
    if (!esc[i] || (open !== '(' && open !== '[')) continue;
    const close = open === '(' ? ')' : ']';
    let j = i + 1;
    while (j < value.length && !(esc[j] && value[j] === close)) j++;
    if (j >= value.length) break; // unclosed (still streaming): text
    const tex = raw.slice(at[i]! + 1, at[j]! - 1).trim();
    if (!tex) continue;
    if (i > last) out.push({ type: 'text', value: value.slice(last, i) });
    out.push(texNode(tex, open === '['));
    last = j + 1;
    i = j;
  }
  if (last === 0) return [text];
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

function walkTex(node: MdNode, source: string): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text') return splitTex(child, source);
    walkTex(child, source);
    return [child];
  });
}

const remarkTexDelimiters = () => (tree: MdNode, file: { value?: unknown }) => walkTex(tree, String(file.value ?? ''));

export const REMARK_ENHANCE = [[remarkMath, { singleDollarTextMath: false }], remarkTexDelimiters] as never[];
/** No `maxExpand`: KaTeX's own limit (1000) is finite, and a lower one breaks ordinary blocks (a dozen `\implies`). */
export const KATEX_OPTIONS = { throwOnError: false, strict: 'ignore', maxSize: 20 } as const;
type HNode = { type: string; tagName?: string; value?: string; properties?: { className?: unknown }; children?: HNode[] };

/** highlight.js marks a hunk line only with counts on both sides (`@@ -1,3 +1,4 @@`); `@@ -1 +1 @@` gets the same span here. */
function markHunks(code: HNode): void {
  let lineStart = true;
  code.children = (code.children ?? []).flatMap((child): HNode[] => {
    if (child.type !== 'text') {
      lineStart = false;
      return [child];
    }
    const out: HNode[] = [];
    for (const piece of (child.value ?? '').split(/(?<=\n)/)) {
      if (lineStart && piece.startsWith('@@')) {
        const body = piece.replace(/\n$/, '');
        out.push({ type: 'element', tagName: 'span', properties: { className: ['hljs-meta'] }, children: [{ type: 'text', value: body }]});
        if (body.length < piece.length) out.push({ type: 'text', value: '\n' });
      } else if (piece) out.push({ type: 'text', value: piece });
      lineStart = piece.endsWith('\n');
    }
    return out;
  });
}

function walkDiff(node: HNode): void {
  for (const child of node.children ?? []) {
    const cls = child.properties?.className;
    if (child.tagName === 'code' && Array.isArray(cls) && cls.includes('language-diff')) markHunks(child);
    else walkDiff(child);
  }
}

const rehypeDiffHunks = () => (tree: HNode) => walkDiff(tree);

export const REHYPE_ENHANCE = [[rehypeHighlight, { detect: false }], rehypeDiffHunks, [rehypeKatex, KATEX_OPTIONS]] as never[];
