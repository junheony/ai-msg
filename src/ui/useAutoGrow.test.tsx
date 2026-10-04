// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { autoGrow, useAutoGrow } from './useAutoGrow';

/** jsdom has no layout: scrollHeight follows the line count (20px a line). */
function fakeLayout(ta: HTMLTextAreaElement) {
  Object.defineProperty(ta, 'scrollHeight', { configurable: true, get: () => ta.value.split('\n').length * 20 });
}

describe('autoGrow', () => {
  it('fits the height to the text and shrinks back when emptied', () => {
    const ta = document.createElement('textarea');
    fakeLayout(ta);
    ta.value = 'a\nb\nc';
    autoGrow(ta);
    expect(ta.style.height).toBe('60px');
    ta.value = '';
    autoGrow(ta);
    expect(ta.style.height).toBe('20px');
  });

  it('leaves the height to CSS when there is no layout (scrollHeight 0)', () => {
    const ta = document.createElement('textarea');
    autoGrow(ta);
    expect(ta.style.height).toBe('auto');
  });
});

describe('useAutoGrow', () => {
  afterEach(cleanup);
  function Box({ text }: { text: string }) {
    const ref = useRef<HTMLTextAreaElement>(null);
    useAutoGrow(ref, text);
    return <textarea ref={(el) => { if (el) fakeLayout(el); ref.current = el; }} value={text} readOnly />;
  }

  it('re-fits on every value change (a send clears the composer → it shrinks)', () => {
    const { container, rerender } = render(<Box text={'one\ntwo\nthree\nfour'} />);
    const ta = container.querySelector('textarea')!;
    expect(ta.style.height).toBe('80px');
    rerender(<Box text="" />);
    expect(ta.style.height).toBe('20px');
  });
});
