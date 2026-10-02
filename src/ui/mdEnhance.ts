import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';

/**
 * Syntax highlighting (highlight.js common languages) and math (KaTeX). Loaded on demand by MessageView
 * (dynamic import) so a chat without code or formulas never downloads them.
 */
export const REMARK_ENHANCE = [remarkMath];
export const REHYPE_ENHANCE = [[rehypeHighlight, { detect: false }], [rehypeKatex, { throwOnError: false, strict: 'ignore' }]] as never[];
