// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { canTakeFocus, composerOf, focusComposer, routeContext, shouldRouteKey } from './composerFocus';

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; isComposing: boolean; keyCode: number; defaultPrevented: boolean }> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods });
const idle = { typing: false, popupOpen: false, interactive: false };

describe('shouldRouteKey (type-to-compose)', () => {
  it('routes printable keys when nothing editable has focus', () => {
    for (const k of ['a', 'Z', '1', '?', '한', '😀']) expect(shouldRouteKey(key(k), idle)).toBe(true);
  });
  it('ignores non-printable keys', () => {
    for (const k of ['Enter', 'Tab', 'Escape', 'ArrowUp', 'F5', 'Dead', 'Process', 'Shift', 'Backspace']) expect(shouldRouteKey(key(k), idle)).toBe(false);
  });
  it('ignores ⌘ / Ctrl / Alt and IME composition', () => {
    expect(shouldRouteKey(key('k', { metaKey: true }), idle)).toBe(false);
    expect(shouldRouteKey(key('k', { ctrlKey: true }), idle)).toBe(false);
    expect(shouldRouteKey(key('k', { altKey: true }), idle)).toBe(false);
    expect(shouldRouteKey(key('a', { isComposing: true }), idle)).toBe(false);
    expect(shouldRouteKey(key('a', { keyCode: 229 }), idle)).toBe(false);
    expect(shouldRouteKey(key('a', { defaultPrevented: true }), idle)).toBe(false);
  });
  it('ignores keys while typing elsewhere or with a palette / menu / dialog open', () => {
    expect(shouldRouteKey(key('a'), { ...idle, typing: true })).toBe(false);
    expect(shouldRouteKey(key('a'), { ...idle, popupOpen: true })).toBe(false);
  });
  it('a space on a focused button presses it; a letter still routes', () => {
    expect(shouldRouteKey(key(' '), { ...idle, interactive: true })).toBe(false);
    expect(shouldRouteKey(key(' '), idle)).toBe(true);
    expect(shouldRouteKey(key('a'), { ...idle, interactive: true })).toBe(true);
  });
});

describe('composer focus', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  const setup = () => {
    document.body.innerHTML = `
      <section data-testid="pane-p1"><div class="composer"><textarea id="c1">draft</textarea></div><textarea id="edit"></textarea><button id="b">x</button></section>
      <section data-testid="pane-p2"><div class="newchat"><textarea id="c2"></textarea></div></section>`;
    return (id: string) => document.getElementById(id) as HTMLTextAreaElement;
  };

  it('finds each pane\'s composer (chat or new-chat screen)', () => {
    const $ = setup();
    expect(composerOf('p1')).toBe($('c1'));
    expect(composerOf('p2')).toBe($('c2'));
    expect(composerOf('p9')).toBeNull();
  });

  it('focuses the composer with the caret at the end, only on a fine pointer', () => {
    const $ = setup();
    expect(focusComposer('p1', { fine: false })).toBe(false);
    expect(document.activeElement).toBe(document.body);
    expect(focusComposer('p1', { fine: true })).toBe(true);
    expect(document.activeElement).toBe($('c1'));
    expect($('c1').selectionStart).toBe(5);
  });

  it('never takes focus out of a field being edited, nor over a menu / palette', () => {
    const $ = setup();
    $('edit').focus();
    expect(canTakeFocus()).toBe(false);
    expect(focusComposer('p1', { fine: true })).toBe(false);
    expect(document.activeElement).toBe($('edit'));
    // From another composer or a button: fine.
    $('c2').focus();
    expect(canTakeFocus()).toBe(true);
    $('b').focus();
    expect(canTakeFocus()).toBe(true);
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    expect(canTakeFocus()).toBe(false);
    menu.remove();
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.append(modal);
    expect(focusComposer('p1', { fine: true })).toBe(false);
  });

  it('routeContext reads typing / popups / buttons from the DOM', () => {
    const $ = setup();
    expect(routeContext(document.body)).toEqual({ typing: false, popupOpen: false, interactive: false });
    expect(routeContext($('edit')).typing).toBe(true);
    expect(routeContext($('b')).interactive).toBe(true);
  });
});
