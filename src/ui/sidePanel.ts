import { createContext } from 'react';
import type { FileDiff } from './diff';

/** What a pane's side panel shows: a file of the session folder (with its edit diffs when opened from one), or a reply's HTML. */
export type SideDoc =
  | { kind: 'file'; path: string; diffs?: FileDiff[] }
  | { kind: 'html'; title: string; html: string }
  | { kind: 'pick' };

/** Supplied by the pane; null outside one (tests, sidebar search), where paths stay plain text. */
export const SidePanelContext = createContext<((doc: SideDoc) => void) | null>(null);

/**
 * The session folder for paths in an assistant reply (null elsewhere: user messages, the side panel's own markdown).
 * Its presence is what lets a reply's image path render as an inline thumbnail.
 */
export const FileRootContext = createContext<string | null>(null);

/**
 * Review I8: an inline thumbnail may only make the browser fetch a file of the session folder through deck's own
 * /api/file, so the path must be relative without `..`, or absolute under `cwd` (the server checks containment too).
 */
export function inSessionFolder(path: string, cwd: string): boolean {
  if (path.split('/').includes('..')) return false;
  if (path.startsWith('/')) return cwd.length > 1 && path.startsWith(`${cwd.replace(/\/+$/, '')}/`);
  return !path.startsWith('~');
}

/**
 * The path of the document whose markdown is being shown (the side panel's 보기 tab); null in replies. Its relative
 * links and images resolve next to it (`[plan](./plan.md)` in docs/spec.md → docs/plan.md); inline code paths do not.
 */
export const DocLinkContext = createContext<string | null>(null);

const KNOWN_EXT = new Set('ts tsx js jsx mjs cjs json jsonl md mdx txt py rb go rs java kt swift c h cc cpp hpp cs php sh zsh bash fish yml yaml toml ini cfg conf env css scss less html htm svg xml sql graphql proto lock png jpg jpeg gif webp vue svelte astro dockerfile makefile gradle tf lua dart ex exs erl hs ml r scala'.split(' '));

/**
 * A reply's inline code / link text that names a file (`src/ui/App.tsx`, `/abs/x.md:12`, `./a.py`, `README.md`): the path
 * without a trailing `:line[:col]`, or null. Needs a slash or a known extension, so `console.log` or `a.b` stay text.
 */
export function filePathIn(text: string): string | null {
  const t = text.trim();
  if (t.length > 300 || /\s/.test(t) || /^[a-z][\w+.-]*:\/\//i.test(t)) return null;
  const m = /^((?:~\/|\/|\.{1,2}\/)?[\p{L}\p{N}_@.+-]+(?:\/[\p{L}\p{N}_@.+-]+)*\.([A-Za-z0-9]{1,10}))(?::\d+(?:[-:]\d+)?)?$/u.exec(t);
  if (!m) return null;
  const [, p, ext] = m;
  if (!p!.includes('/') && !KNOWN_EXT.has(ext!.toLowerCase())) return null;
  if (/^\d+(\.\d+)+$/.test(p!)) return null; // 1.2.3
  return p!;
}

export type FileView = 'markdown' | 'html' | 'image' | 'text';

/** How the panel shows a file, by extension (the server decides text vs image by content). */
export function viewFor(path: string): FileView {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  if (ext === 'md' || ext === 'mdx' || ext === 'markdown') return 'markdown';
  if (ext === 'html' || ext === 'htm' || ext === 'svg') return 'html';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
  return 'text';
}

/** Side panel width (px) bounds; the chat keeps at least CHAT_MIN. */
export const SIDE_MIN = 260;
export const CHAT_MIN = 280;
export function clampSideWidth(w: number, total: number): number {
  return Math.round(Math.max(SIDE_MIN, Math.min(w, total - CHAT_MIN)));
}
