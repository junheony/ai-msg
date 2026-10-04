import { isTypingTarget } from './shortcuts';

/** The composers deck types into: an open chat's and the new-chat screen's. */
const COMPOSER = '.composer textarea, .newchat textarea';
/** Something on screen that owns the keyboard: a modal (palette, settings, confirm…), a popover dialog, a menu or a list. */
const POPUP = '[aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
/** Focused controls where a space (or Enter) means "press me", not "type". */
const INTERACTIVE = 'button, a[href], select, summary, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="tab"], [role="checkbox"], [role="switch"]';

export function hasOpenPopup(root: ParentNode = document): boolean {
  return root.querySelector(POPUP) !== null;
}

export function isComposer(el: Element | null): boolean {
  return !!el && el.matches(COMPOSER);
}

/** The composer of pane `paneId` (absent: the pane shows no composer, e.g. no projects yet). */
export function composerOf(paneId: string, root: ParentNode = document): HTMLTextAreaElement | null {
  return root.querySelector(`[data-testid="pane-${paneId}"]`)?.querySelector<HTMLTextAreaElement>(COMPOSER) ?? null;
}

/**
 * Touch screens: focusing a textarea pops the on-screen keyboard over half the screen, so deck only moves focus by
 * itself with a mouse/trackpad as the primary pointer (Desktop; an iPad user taps the composer when they want to type).
 */
export function finePointer(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;
}

/** May deck move focus to a composer now? Not over a palette/menu/dialog, nor out of a field the user is editing (rename, 메시지 편집…). */
export function canTakeFocus(doc: Document = document): boolean {
  if (hasOpenPopup(doc)) return false;
  const a = doc.activeElement;
  return !isTypingTarget(a) || isComposer(a);
}

/** Opening a chat / 새 채팅 / ⌘N / a pane switch: the caret goes to that pane's composer (end of any draft). */
export function focusComposer(paneId: string, opts: { fine?: boolean; doc?: Document } = {}): boolean {
  const doc = opts.doc ?? document;
  if (!(opts.fine ?? finePointer()) || !canTakeFocus(doc)) return false;
  const ta = composerOf(paneId, doc);
  if (!ta) return false;
  if (doc.activeElement !== ta) {
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  return true;
}

export type RoutedKey = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'> & { isComposing?: boolean; keyCode?: number; defaultPrevented?: boolean };

/**
 * Type-to-compose: a printable key pressed while nothing editable has focus goes to the focused pane's composer
 * (Desktop). Never with ⌘/Ctrl/Alt (shortcuts), during IME composition, over a palette/menu/dialog, or a space on a
 * focused button (that presses it).
 */
export function shouldRouteKey(e: RoutedKey, ctx: { typing: boolean; popupOpen: boolean; interactive: boolean }): boolean {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  // One character (an emoji is one too): not Enter, Tab, Escape, arrows, F-keys, Dead, Process…
  if ([...e.key].length !== 1) return false;
  if (ctx.typing || ctx.popupOpen) return false;
  return !(ctx.interactive && e.key === ' ');
}

/** The keydown's context for shouldRouteKey, read from the DOM. */
export function routeContext(target: EventTarget | null, doc: Document = document): { typing: boolean; popupOpen: boolean; interactive: boolean } {
  return {
    typing: isTypingTarget(target),
    popupOpen: hasOpenPopup(doc),
    interactive: target instanceof Element && target.closest(INTERACTIVE) !== null,
  };
}
