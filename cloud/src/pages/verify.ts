import { esc, page } from './layout';

/** One button, so a mail scanner opening the link does not spend the token; only the POST does. */
export const verifyPage = (token: string): Response =>
  page('Sign in', `<h1>Sign in to AI msg</h1>
<form method="post" action="/auth/verify">
<input type="hidden" name="t" value="${esc(token)}">
<button type="submit">Sign in</button>
</form>`);

export const verifyFailedPage = (): Response =>
  page('Link expired', '<h1>This link has expired</h1><p>Sign-in links work once, for 15 minutes. <a href="/login">Get a new one</a>.</p>', { status: 400 });
