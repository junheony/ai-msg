// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Sheet } from './Dialogs';

describe('Sheet focus', () => {
  afterEach(cleanup);

  it('nothing in it took focus: the first control gets it; Tab / Shift+Tab wrap inside', () => {
    render(<Sheet className="t" label="시트" onClose={() => {}}><button type="button">첫째</button><input aria-label="둘째" /><button type="button">셋째</button></Sheet>);
    const first = screen.getByRole('button', { name: '첫째' });
    const last = screen.getByRole('button', { name: '셋째' });
    expect(document.activeElement).toBe(first);
    act(() => { last.focus(); });
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('an autoFocus 닫기 keeps the first focus; an inner trap that already wrapped is not wrapped twice', () => {
    const inner = vi.fn();
    render(
      <Sheet className="t" label="시트" onClose={() => {}}>
        <div onKeyDown={(e) => { inner(); if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); (e.currentTarget.querySelector('button') as HTMLElement).focus(); } }}>
          <button type="button">맨 앞</button>
          <button type="button" aria-label="닫기" autoFocus>✕</button>
        </div>
      </Sheet>,
    );
    const close = screen.getByRole('button', { name: '닫기' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '맨 앞' }));
  });

  it('Esc still closes it and focus goes back to the opener', () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return <><button type="button" onClick={() => setOpen(true)}>열기</button>{open && <Sheet className="t" label="시트" onClose={() => setOpen(false)}><button type="button">안</button></Sheet>}</>;
    }
    render(<Host />);
    const opener = screen.getByRole('button', { name: '열기' });
    act(() => { opener.focus(); });
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '안' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
