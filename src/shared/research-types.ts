/** The 리서치 panel's feed: articles and outside sources read from ~/.msg/research (schema in docs/research.md). */
export const RESEARCH_CATEGORIES = ['Research house', 'Data', 'AI-GPU'] as const;
export type ResearchCategory = (typeof RESEARCH_CATEGORIES)[number];

export interface ResearchArticle {
  id: string;
  title: string;
  /** YYYY-MM-DD. */
  date: string;
  /** One-line conclusion; empty until the research bot sends it. */
  summary: string;
  tags: string[];
  url: string;
  source: string;
  pinned?: boolean;
  updatedDaily?: boolean;
}

export interface ResearchSource {
  name: string;
  nameKo?: string;
  url: string;
  focus: string;
  category: ResearchCategory;
  ownerPick: boolean;
}

/** `missing`: the file is not there yet (a normal, empty state). `invalid`: unreadable or not a JSON array. */
export type ResearchFileState = 'ok' | 'missing' | 'invalid';

export interface ResearchResponse {
  /** Lead first: pinned, then dated newest first, then the daily-updated pieces. */
  articles: ResearchArticle[];
  sources: ResearchSource[];
  files: { articles: ResearchFileState; sources: ResearchFileState };
  /** Entries left out because they did not match the schema. */
  skipped: { articles: number; sources: number };
}
