import { esc, page } from './layout';

export const loginPage = (next: string | null): Response =>
  page('Sign in', `<h1>Sign in to AI msg</h1>
<form method="post" action="/login">
<label>Email <input type="email" name="email" required autocomplete="email"></label>
${next ? `<input type="hidden" name="next" value="${esc(next)}">` : ''}
<button type="submit">Email me a sign-in link</button>
</form>`);

export const loginSentPage = (): Response =>
  page('Check your email', '<h1>Check your email</h1><p>If the address can sign in, a link is on its way. It works once, for 15 minutes.</p>');
