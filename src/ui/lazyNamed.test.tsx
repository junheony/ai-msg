// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { lazyNamed } from './lazyNamed';

describe('lazyNamed', () => {
  it('renders the loaded view after the chunk resolves', async () => {
    function Panel({ title }: { title: string }) {
      return <h2>{title}</h2>;
    }
    const View = lazyNamed(() => Promise.resolve(Panel));
    render(<View title="설정" />);
    expect(await screen.findByRole('heading', { name: '설정' })).toBeTruthy();
    cleanup();
  });
});
