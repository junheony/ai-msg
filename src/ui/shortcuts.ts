/** Global keyboard shortcuts: ⌘ on Mac, Ctrl elsewhere. */
export type ShortcutId = 'palette' | 'help' | 'new-chat' | 'new-pane' | 'prev-session' | 'next-session' | 'toggle-sidebar' | 'settings' | 'prev-pane' | 'next-pane' | 'close-pane' | 'arrange-cards' | 'max-pane' | 'move-pane-left' | 'move-pane-right' | 'toggle-side';

/**
 * By physical key (`code`), so a Korean input source still matches. `typing`: also fires while a text field
 * has focus — ⌘[ / ⌘] do not (they would yank the user out of a half-written message). `alt`: also needs ⌥ (Alt).
 *
 * Pane keys avoid the browsers' own: ⌘⌥←/→ switches tabs in Chrome / Firefox (and Ctrl+Alt+←/→ switches workspaces on
 * Linux desktops), so panes step on ⌘⌥[ / ⌘⌥]; ⌘⇧W closes the window in Safari / Chrome (a page cannot keep it), so a
 * pane closes on ⌘⇧X. ⌘⇧[ / ⌘⇧] switch tabs in Safari / Chrome, so a pane moves on ⌘⌥⇧[ / ⌘⌥⇧] (the same keys as
 * stepping, with ⇧). ⌘⇧Enter only maximizes: the composers send on ⌘Enter without ⇧.
 */
const BINDINGS: { id: ShortcutId; code: string; shift: boolean; alt?: boolean; typing: boolean; keys: string; label: string }[] = [
  { id: 'palette', code: 'KeyK', shift: false, typing: true, keys: 'K', label: '명령 팔레트 · 세션 검색' },
  { id: 'new-chat', code: 'KeyN', shift: false, typing: true, keys: 'N', label: '새 대화 (지금 패널의 프로젝트)' },
  { id: 'new-pane', code: 'KeyO', shift: true, typing: true, keys: '⇧O', label: '새 분할 패널' },
  { id: 'prev-session', code: 'BracketLeft', shift: false, typing: false, keys: '[', label: '이전 세션 (목록 위)' },
  { id: 'next-session', code: 'BracketRight', shift: false, typing: false, keys: ']', label: '다음 세션 (목록 아래)' },
  { id: 'prev-pane', code: 'BracketLeft', shift: false, alt: true, typing: true, keys: '⌥[', label: '이전 패널 (왼쪽)' },
  { id: 'next-pane', code: 'BracketRight', shift: false, alt: true, typing: true, keys: '⌥]', label: '다음 패널 (오른쪽)' },
  { id: 'close-pane', code: 'KeyX', shift: true, typing: true, keys: '⇧X', label: '지금 패널 닫기 (마지막 패널은 그대로)' },
  { id: 'move-pane-left', code: 'BracketLeft', shift: true, alt: true, typing: true, keys: '⌥⇧[', label: '지금 패널을 왼쪽으로 옮기기' },
  { id: 'move-pane-right', code: 'BracketRight', shift: true, alt: true, typing: true, keys: '⌥⇧]', label: '지금 패널을 오른쪽으로 옮기기' },
  { id: 'max-pane', code: 'Enter', shift: true, typing: true, keys: '⇧Enter', label: '지금 패널 최대화/복원 (다른 패널 숨김)' },
  { id: 'toggle-side', code: 'KeyE', shift: true, typing: true, keys: '⇧E', label: '오른쪽 문서 패널 열기/닫기' },
  { id: 'arrange-cards', code: 'KeyG', shift: true, typing: true, keys: '⇧G', label: '떠 있는 카드 정렬 (카드 2장 이상일 때)' },
  { id: 'toggle-sidebar', code: 'Backslash', shift: false, typing: true, keys: '\\', label: '사이드바 열기/닫기' },
  { id: 'settings', code: 'Comma', shift: false, typing: true, keys: ',', label: '설정' },
  { id: 'help', code: 'Slash', shift: false, typing: true, keys: '/', label: '단축키 보기' },
];

/** `code` fallback from `key` for synthetic events / old browsers. */
const KEY_TO_CODE: Record<string, string> = { k: 'KeyK', n: 'KeyN', o: 'KeyO', x: 'KeyX', g: 'KeyG', e: 'KeyE', enter: 'Enter', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', '/': 'Slash', ',': 'Comma' };

/** A ⌘-shortcut's label: ⌘⌥⇧[ on a Mac, Ctrl+Alt+Shift+[ elsewhere (⌥ ⇧ ↩ spelled out as Alt / Shift / Enter). */
export function modKeys(keys: string, mac: boolean): string {
  return mac ? `⌘${keys}` : `Ctrl+${keys.replace(/⌥/g, 'Alt+').replace(/⇧/g, 'Shift+').replace(/↩/g, 'Enter')}`;
}

export function isMacPlatform(nav: { platform?: string; userAgent?: string } | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(nav?.platform || nav?.userAgent || '');
}

/** Focus is somewhere text is typed. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes((el as HTMLInputElement).type);
}

export type ShortcutKey = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'> & { isComposing?: boolean; keyCode?: number };

/** The shortcut this keydown is, or null. Never during IME composition. */
export function matchShortcut(e: ShortcutKey, opts: { mac: boolean; typing: boolean }): ShortcutId | null {
  if (e.isComposing || e.keyCode === 229) return null;
  const mod = opts.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod) return null;
  const code = e.code === 'NumpadEnter' ? 'Enter' : e.code || KEY_TO_CODE[e.key.toLowerCase()] || '';
  const b = BINDINGS.find((x) => x.code === code && x.shift === e.shiftKey && !!x.alt === e.altKey);
  if (!b || (opts.typing && !b.typing)) return null;
  // Ctrl+Alt off a Mac is AltGr on many layouts: in a text field that key types a character, so it stays the field's.
  if (b.alt && !opts.mac && opts.typing) return null;
  return b.id;
}

/** 고정됨 rows with a number shortcut: ⌘1 … ⌘9. */
export const PIN_KEYS = 9;

/** ⌘/Ctrl alone — no Shift or Alt, and not the other platform's modifier. */
export function isPlainMod(e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, mac: boolean): boolean {
  return (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.shiftKey && !e.altKey;
}

/**
 * ⌘1 … ⌘9 (Ctrl elsewhere): the index of the 고정됨 row this keydown opens, or null. By physical key, top row only;
 * never with Shift / Alt. A repeat matches too, so the caller can keep the browser's own ⌘N off it.
 *
 * Also mid-IME: a Hangul syllable stays in composition in the composer until the next key commits it, so ⌘1 right after
 * typing Korean arrives with isComposing true — skipping it left the key to the browser (its own tab switch). A ⌘-digit
 * is never part of a composition; then only `code` counts (the IME may have rewritten `key`).
 */
export function matchPinShortcut(e: ShortcutKey, mac: boolean): number | null {
  if (!isPlainMod(e, mac)) return null;
  const composing = e.isComposing || e.keyCode === 229;
  const digit = /^Digit([1-9])$/.exec(e.code || '') ?? (e.code || composing ? null : /^([1-9])$/.exec(e.key));
  return digit ? Number(digit[1]) - 1 : null;
}

/**
 * ⌘⌥1 … ⌘⌥9 (Ctrl+Alt elsewhere): the index of the split pane to focus (left to right), or null. By physical key, so a
 * Korean input source (or ⌥ turning the digit into a symbol on a Mac) still matches; never with Shift or mid-IME.
 * Ctrl+Alt off a Mac in a text field is AltGr there, so it stays the field's.
 */
export function matchPaneShortcut(e: ShortcutKey, opts: { mac: boolean; typing: boolean }): number | null {
  if (e.isComposing || e.keyCode === 229 || e.shiftKey || !e.altKey) return null;
  if (!(opts.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return null;
  if (!opts.mac && opts.typing) return null;
  const digit = /^Digit([1-9])$/.exec(e.code || '') ?? (e.code ? null : /^([1-9])$/.exec(e.key));
  return digit ? Number(digit[1]) - 1 : null;
}

/** The hint on the nth 고정됨 row ("⌘1"), or null past the ninth. */
export function pinKeyLabel(index: number, mac: boolean): string | null {
  return index < PIN_KEYS ? `${mac ? '⌘' : 'Ctrl+'}${index + 1}` : null;
}

/** Cheat-sheet rows: key label with the platform's modifier. */
export function shortcutList(mac: boolean): { id: ShortcutId; keys: string; label: string }[] {
  const mod = mac ? '⌘' : 'Ctrl+';
  return BINDINGS.map((b) => ({ id: b.id, keys: `${mod}${mac || !b.alt ? b.keys : b.keys.replace('⌥', 'Alt+')}`, label: b.label }));
}
