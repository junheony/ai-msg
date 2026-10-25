// Pure Markdown → HTML for the legal pages (no `node:` imports; build-legal.mjs does the file work).
// Only this subset is accepted: `#`/`##`/`###` headings, paragraphs, `> ` quotes, `- ` lists, `1. ` lists (one level),
// pipe tables (header row + `|---|` row), `**bold**`, `` `code` ``, `[text](href)`. Text is HTML-escaped first, then
// only that subset becomes tags. Anything else (raw HTML, images, code fences, indented/nested lists, `*em*`/`_em_`,
// footnotes, rules) throws `LegalSyntaxError` with the line number, so the build fails instead of guessing.

export class LegalSyntaxError extends Error {
  /** @param {number} line 1-based @param {string} why */
  constructor(line, why) {
    super(`line ${line}: ${why}`);
    this.name = 'LegalSyntaxError';
    this.line = line;
  }
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => s.replace(/[&<>"']/g, (ch) => ESC[ch]);

const PLACEHOLDER = /\{\{[^{}]*\}\}/g;
const LINK = /\[([^\]]+)\]\(([^()\s]+)\)/g;
/** An underscore at a word edge starts or ends `_emphasis_` (`snake_case` inside a word is plain text). */
const UNDERSCORE_EM = /(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/u;
const DRAFT = /DRAFT|초안/;

/** Placeholders (`{{…}}`) in already-escaped text become a visible mark. */
const markTodo = (html) => html.replace(PLACEHOLDER, (m) => `<mark class="todo">${m}</mark>`);

function href(raw, line, links) {
  if (Object.hasOwn(links, raw)) return links[raw];
  if (/^https:\/\/[^\s]+$/.test(raw) || /^mailto:[^\s]+$/.test(raw)) return raw;
  throw new LegalSyntaxError(line, `link target not allowed: ${raw}`);
}

/** Plain text (no code span): links, then escape, then `**bold**`. */
function text(raw, line, links) {
  if (raw.includes('*') && raw.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '').includes('*')) throw new LegalSyntaxError(line, 'only **bold** is supported (no *emphasis*)');
  if (UNDERSCORE_EM.test(raw)) throw new LegalSyntaxError(line, '_emphasis_ is not supported');
  const piece = (s) => {
    if (s.includes('](')) throw new LegalSyntaxError(line, 'malformed link');
    return markTodo(esc(s).replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>'));
  };
  let out = '';
  let at = 0;
  for (const m of raw.matchAll(LINK)) {
    out += piece(raw.slice(at, m.index)) + `<a href="${esc(href(m[2], line, links))}">${piece(m[1])}</a>`;
    at = m.index + m[0].length;
  }
  return out + piece(raw.slice(at));
}

function inline(raw, line, links) {
  if (raw.includes('<')) throw new LegalSyntaxError(line, 'raw HTML is not supported');
  if (raw.includes('![')) throw new LegalSyntaxError(line, 'images are not supported');
  if (raw.includes('[^')) throw new LegalSyntaxError(line, 'footnotes are not supported');
  const parts = raw.split('`');
  if (parts.length % 2 === 0) throw new LegalSyntaxError(line, 'unclosed `code`');
  return parts.map((p, i) => (i % 2 ? `<code>${markTodo(esc(p))}</code>` : text(p, line, links))).join('');
}

const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/**
 * @param {string} md
 * @param {{ strict: boolean; links: Record<string, string> }} o
 * @returns {{ title: string; html: string; placeholders: string[]; marks: { line: number; text: string }[]; draft: boolean }}
 */
export function renderLegal(md, o) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  /** @type {{ line: number; text: string }[]} */
  const marks = [];
  let title = '';
  let para = [];
  let list = null; // { tag, items }
  let quote = null; // string[]
  let quotes = 0; // quote blocks started so far; only the first may carry the DRAFT banner
  let table = null; // { head, rows }

  const flush = () => {
    if (para.length) html.push(`<p>${para.join(' ')}</p>`);
    if (list) html.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`);
    if (quote) html.push(`<blockquote><p>${quote.join('<br>')}</p></blockquote>`);
    if (table) {
      const head = `<thead><tr>${table.head.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;
      html.push(`<table>${head}<tbody>${table.rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    }
    para = []; list = null; quote = null; table = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const n = i + 1;
    for (const m of raw.matchAll(PLACEHOLDER)) marks.push({ line: n, text: m[0] });
    if (raw.trim() === '') { flush(); continue; }
    if (/^\s/.test(raw)) throw new LegalSyntaxError(n, 'indented lines (nested lists, indented code) are not supported');
    if (raw.startsWith('```') || raw.startsWith('~~~')) throw new LegalSyntaxError(n, 'code fences are not supported');
    if (/^(-{3,}|\*{3,}|_{3,}|={3,})$/.test(raw)) throw new LegalSyntaxError(n, 'rules and underlined headings are not supported');

    const h = /^(#{1,6}) (.+)$/.exec(raw);
    if (h) {
      if (h[1].length > 3) throw new LegalSyntaxError(n, 'only #, ## and ### headings are supported');
      flush();
      if (h[1].length === 1 && !title) title = h[2].replace(/\*\*|`/g, '').trim();
      html.push(`<h${h[1].length}>${inline(h[2], n, o.links)}</h${h[1].length}>`);
      continue;
    }
    const q = /^>( (.*))?$/.exec(raw);
    if (q) {
      if (!quote) { flush(); quote = []; quotes++; }
      const body = q[2] ?? '';
      if (quotes === 1 && DRAFT.test(body) && !marks.some((m) => m.text === 'DRAFT')) marks.push({ line: n, text: 'DRAFT' });
      quote.push(inline(body, n, o.links));
      continue;
    }
    if (quote) flush();

    const li = /^- (.+)$/.exec(raw);
    const ol = /^\d+\. (.+)$/.exec(raw);
    if (li || ol) {
      const tag = li ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flush(); list = { tag, items: [] }; }
      list.items.push(inline((li ?? ol)[1], n, o.links));
      continue;
    }
    if (raw.startsWith('|')) {
      if (!table) {
        flush();
        const sep = lines[i + 1] ?? '';
        if (!/^\|(\s*:?-+:?\s*\|)+\s*$/.test(sep)) throw new LegalSyntaxError(n + 1, 'a table needs a |---| row under its header');
        table = { head: cells(raw).map((c) => inline(c, n, o.links)), rows: [] };
        i++;
        continue;
      }
      table.rows.push(cells(raw).map((c) => inline(c, n, o.links)));
      continue;
    }
    if (list || table) flush();
    para.push(inline(raw, n, o.links));
  }
  flush();

  const draft = marks.some((m) => m.text === 'DRAFT');
  if (o.strict && marks.length) throw new LegalSyntaxError(marks[0].line, `draft mark left: ${marks[0].text}`);
  return { title, html: html.join('\n'), placeholders: marks.filter((m) => m.text !== 'DRAFT').map((m) => m.text), marks, draft };
}
