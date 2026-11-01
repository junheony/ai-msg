/**
 * 리서치: articles and outside sources from two JSON files the research bot appends to (docs/research.md). Read on every
 * GET so a new article needs no restart; nothing here writes. A bad entry is left out and counted, never fatal, and only
 * http(s) links get through because the UI puts them in an href.
 */
import fs from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { RESEARCH_CATEGORIES, type ResearchArticle, type ResearchFileState, type ResearchResponse, type ResearchSource } from '../../shared/research-types';

export const RESEARCH_PREFIX = '/api/hub/research';
const MAX_FILE_BYTES = 2_000_000;

const text = z.string().trim().min(1);
const webUrl = text.refine((v) => { try { return /^https?:$/.test(new URL(v).protocol); } catch { return false; } }, 'http(s) URL');
const isoDate = text.refine((v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().startsWith(v), 'YYYY-MM-DD');

export const articleSchema = z.object({
  id: text, title: text, date: isoDate,
  summary: z.string().trim().default(''),
  tags: z.array(text).default([]),
  url: webUrl,
  source: text.default('AI-Crypto 리서치'),
  pinned: z.boolean().optional(),
  updatedDaily: z.boolean().optional(),
});

export const sourceSchema = z.object({
  name: text,
  nameKo: text.optional(),
  url: webUrl,
  focus: text,
  category: z.enum(RESEARCH_CATEGORIES),
  ownerPick: z.boolean().default(false),
});

/** Pinned first, then dated pieces newest first; a daily-updated piece has no news date, so it follows them. */
export function sortArticles(articles: ResearchArticle[]): ResearchArticle[] {
  const rank = (a: ResearchArticle) => (a.pinned ? 0 : a.updatedDaily ? 2 : 1);
  return [...articles].sort((a, b) => rank(a) - rank(b) || b.date.localeCompare(a.date));
}

async function readList(file: string): Promise<{ state: ResearchFileState; items: unknown[] }> {
  try {
    if ((await fs.stat(file)).size > MAX_FILE_BYTES) return { state: 'invalid', items: [] };
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(parsed) ? { state: 'ok', items: parsed } : { state: 'invalid', items: [] };
  } catch (e) {
    return { state: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid', items: [] };
  }
}

function keep<T>(items: unknown[], schema: z.ZodType<T>, key: (v: T) => string): { kept: T[]; skipped: number } {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const item of items) {
    const r = schema.safeParse(item);
    if (!r.success || seen.has(key(r.data))) continue;
    seen.add(key(r.data));
    kept.push(r.data);
  }
  return { kept, skipped: items.length - kept.length };
}

export const researchDir = (home: string = os.homedir()): string => process.env.MSG_RESEARCH_DIR ?? path.join(home, '.msg', 'research');

export interface ResearchService { get(): Promise<ResearchResponse> }

export function createResearchService(dir: string): ResearchService {
  return {
    async get() {
      const [a, s] = await Promise.all([readList(path.join(dir, 'articles.json')), readList(path.join(dir, 'sources.json'))]);
      const articles = keep(a.items, articleSchema as z.ZodType<ResearchArticle>, (v) => v.id);
      const sources = keep(s.items, sourceSchema as z.ZodType<ResearchSource>, (v) => v.url);
      return {
        articles: sortArticles(articles.kept),
        sources: sources.kept,
        files: { articles: a.state, sources: s.state },
        skipped: { articles: articles.skipped, sources: sources.skipped },
      };
    },
  };
}

export async function serveResearch(service: ResearchService, method: string | undefined, res: ServerResponse): Promise<void> {
  res.setHeader('Allow', 'GET');
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (method !== 'GET') { send(405, { error: 'method not allowed' }); return; }
  send(200, await service.get());
}
