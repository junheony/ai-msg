// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Login } from './Login';

afterEach(cleanup);

describe('Login', () => {
  it('one plain line up front; the command lives only behind the 토큰은 어디 있나요? fold', () => {
    const { container } = render(<Login onLoggedIn={() => {}} />);
    expect(screen.getByText('이 컴퓨터의 deck 이 만든 로그인 토큰을 붙여 넣으세요.')).toBeTruthy();
    const fold = container.querySelector('details.login-where') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(fold.querySelector('code')?.textContent).toBe('ai-msg login-url');
    // Nothing outside the fold names the command.
    expect(container.querySelector('form > p')?.textContent).not.toContain('ai-msg');
    expect(screen.getByRole('button', { name: '로그인' }).className).toContain('primary');
  });
});
