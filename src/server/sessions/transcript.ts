import fs from 'node:fs/promises';
import type { TranscriptMessage } from '../../shared/session-types';

export type HeadInfo = { cwd: string | null; title: string | null };

type Rec = Record<string, unknown>;

function parseLines(text: string): Rec[] {
  const out: Rec[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as unknown;
      if (o && typeof o === 'object') out.push(o as Rec);
    } catch {
      // truncated or non-JSON line: skip
    }
  }
  return out;
}

export function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const block = b as Rec;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[이미지]');
    else if (block.type === 'document') parts.push('[문서]');
  }
  return parts.join('\n');
}

function message(r: Rec): Rec | null {
  const m = r.message;
  return m && typeof m === 'object' ? (m as Rec) : null;
}

function isRealUser(r: Rec): boolean {
  return r.type === 'user' && !r.isCompactSummary && !r.isSidechain;
}

function titleFrom(text: string): string | null {
  const first = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  if (!first || first.startsWith('<')) return null;
  return first.length > 80 ? first.slice(0, 80) : first;
}

export function parseHead(text: string): HeadInfo {
  let cwd: string | null = null;
  let custom: string | null = null;
  let firstUser: string | null = null;
  for (const r of parseLines(text)) {
    if (cwd === null && typeof r.cwd === 'string' && r.cwd) cwd = r.cwd;
    if (r.type === 'custom-title' && typeof r.customTitle === 'string' && r.customTitle.trim()) custom = r.customTitle.trim();
    if (firstUser === null && isRealUser(r)) {
      const m = message(r);
      const t = titleFrom(textOfContent(m?.content));
      if (t) firstUser = t;
    }
  }
  return { cwd, title: custom ?? firstUser };
}

export async function readHead(file: string, maxBytes = 256 * 1024): Promise<HeadInfo> {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return parseHead(buf.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await fh.close();
  }
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return textOfContent(v) || JSON.stringify(v);
  return v === undefined ? '' : JSON.stringify(v);
}

export function parseTranscript(text: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  let lastAssistantId: string | null = null;
  for (const r of parseLines(text)) {
    const ts = typeof r.timestamp === 'string' ? r.timestamp : null;
    if (isRealUser(r)) {
      const m = message(r);
      const content = m?.content;
      if (Array.isArray(content) && content.some((b) => b && typeof b === 'object' && (b as Rec).type === 'tool_result')) {
        for (const b of content) {
          const block = b as Rec;
          if (block.type !== 'tool_result') continue;
          out.push({ kind: 'tool_result', toolUseId: String(block.tool_use_id ?? ''), content: stringify(block.content), isError: block.is_error === true, ts });
        }
        lastAssistantId = null;
        continue;
      }
      const t = textOfContent(content);
      if (t) out.push({ kind: 'user', text: t, ts });
      lastAssistantId = null;
    } else if (r.type === 'assistant' && !r.isSidechain) {
      const m = message(r);
      if (!m) continue;
      const id = typeof m.id === 'string' ? m.id : null;
      const model = typeof m.model === 'string' ? m.model : null;
      const blocks = Array.isArray(m.content) ? (m.content as Rec[]) : [];
      let entry: Extract<TranscriptMessage, { kind: 'assistant' }>;
      const last = out[out.length - 1];
      if (id && id === lastAssistantId && last && last.kind === 'assistant') entry = last;
      else {
        entry = { kind: 'assistant', text: '', model, toolCalls: [], ts };
        out.push(entry);
      }
      for (const b of blocks) {
        if (b.type === 'text' && typeof b.text === 'string') entry.text += (entry.text ? '\n' : '') + b.text;
        else if (b.type === 'tool_use') entry.toolCalls.push({ id: String(b.id ?? ''), name: String(b.name ?? ''), input: b.input });
      }
      lastAssistantId = id;
    }
  }
  return out;
}

export async function readTranscript(file: string): Promise<TranscriptMessage[]> {
  return parseTranscript(await fs.readFile(file, 'utf8'));
}
