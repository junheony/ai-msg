import type { LangPref } from '../shared/locale';

/** Per-device client prefs (localStorage): phone and Mac differ on purpose. Applied to <html> as data-* + --font-scale. */
export const PREFS_KEY = 'deck.prefs.v1';

export type Theme = 'system' | 'light' | 'dark';
export type FontSize = 'small' | 'normal' | 'large' | 'xlarge';
export type ChatWidth = 'narrow' | 'wide';
export type SendKey = 'enter' | 'mod-enter';
export type Prefs = { theme: Theme; fontSize: FontSize; chatWidth: ChatWidth; sendKey: SendKey; /** 간결 모드: results-first chat (default on). */ conciseMode: boolean; /** The sidebar's 고정됨 section folded (default open). */ pinnedFolded: boolean;
  /** UI language, read once at boot (src/ui/i18n). Absent = 'auto' (the browser's languages). */ lang?: LangPref };

/** 보통 = 1: the type tokens (--fs-* in styles.css) are designed at this size; the others step around it. */
export const FONT_SCALE: Record<FontSize, number> = { small: 0.92, normal: 1, large: 1.1, xlarge: 1.25 };
export const DEFAULT_PREFS: Prefs = { theme: 'system', fontSize: 'normal', chatWidth: 'narrow', sendKey: 'enter', conciseMode: true, pinnedFolded: false };

const ALLOWED: { [K in keyof Prefs]-?: readonly NonNullable<Prefs[K]>[] } = {
  theme: ['system', 'light', 'dark'],
  fontSize: ['small', 'normal', 'large', 'xlarge'],
  chatWidth: ['narrow', 'wide'],
  sendKey: ['enter', 'mod-enter'],
  conciseMode: [true, false],
  pinnedFolded: [true, false],
  lang: ['auto', 'en', 'ko'],
};

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const defaultStore = (): Store | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

/** Unknown/invalid fields fall back to the default one by one. */
export function parsePrefs(raw: string | null): Prefs {
  const out: Prefs = { ...DEFAULT_PREFS };
  if (!raw) return out;
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return out; }
  if (!o || typeof o !== 'object') return out;
  for (const k of Object.keys(ALLOWED) as (keyof Prefs)[]) {
    const v = (o as Record<string, unknown>)[k];
    if ((ALLOWED[k] as readonly unknown[]).includes(v)) (out as Record<string, unknown>)[k] = v;
  }
  // Saved before the language setting existed (savePrefs always writes one now): that deck was Korean, so it stays Korean.
  if (!('lang' in o)) out.lang = 'ko';
  return out;
}

export function loadPrefs(store: Store | null = defaultStore()): Prefs {
  try { return parsePrefs(store?.getItem(PREFS_KEY) ?? null); } catch { return { ...DEFAULT_PREFS }; }
}

export function savePrefs(prefs: Prefs, store: Store | null = defaultStore()): void {
  try { store?.setItem(PREFS_KEY, JSON.stringify({ ...prefs, lang: prefs.lang ?? 'auto' })); } catch { /* private mode / quota: the pref just won't persist */ }
}

/** ⌘K 테마 전환: 시스템 → 라이트 → 다크 → 시스템. */
export function nextTheme(t: Theme): Theme {
  return t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system';
}

export type PrefsAction = { type: 'set'; key: keyof Prefs; value: Prefs[keyof Prefs] } | { type: 'reset' };

export function prefsReducer(state: Prefs, action: PrefsAction): Prefs {
  if (action.type === 'reset') return { ...DEFAULT_PREFS };
  if (!(ALLOWED[action.key] as readonly unknown[]).includes(action.value) || state[action.key] === action.value) return state;
  return { ...state, [action.key]: action.value };
}

/** data-theme only when forced; "system" removes it so the prefers-color-scheme fallback applies. */
export function applyPrefs(prefs: Prefs, root: HTMLElement = document.documentElement): void {
  if (prefs.theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', prefs.theme);
  root.setAttribute('data-width', prefs.chatWidth);
  root.setAttribute('data-concise', prefs.conciseMode ? 'on' : 'off');
  root.style.setProperty('--font-scale', String(FONT_SCALE[prefs.fontSize]));
  if (root.ownerDocument) applyThemeColor(prefs.theme, root.ownerDocument);
}

/** The top bar's colour (--sidebar) per theme: the browser chrome / status bar matches the bar under it. */
export const THEME_COLOR = { dark: '#0f1013', light: '#eff0f4' } as const;

/**
 * index.html carries one theme-color meta per colour scheme. A forced theme points both at its colour (the browser
 * would otherwise follow the system scheme); "system" puts each back on its own scheme.
 */
export function applyThemeColor(theme: Theme, doc: Document = document): void {
  for (const m of Array.from(doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))) {
    const own: 'dark' | 'light' = (m.getAttribute('media') ?? '').includes('light') ? 'light' : 'dark';
    m.setAttribute('content', THEME_COLOR[theme === 'system' ? own : theme]);
  }
}
