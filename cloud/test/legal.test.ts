import { describe, expect, it } from 'vitest';
import { NOTICE } from '../src/legal/notice';
import { RELAY, call, loginAs } from './helpers';

describe('legal pages', () => {
  it('/legal/terms and /legal/ko/terms on the app origin, 404 on relay', async () => {
    const en = await call('/legal/terms');
    expect(en.status).toBe(200);
    const enHtml = await en.text();
    expect(enHtml).toContain('<html lang="en">');
    expect(enHtml).toContain('Terms of Service');
    expect(en.headers.get('cache-control')).toBe('public, max-age=3600');
    const ko = await call('/legal/ko/terms');
    expect(ko.status).toBe(200);
    expect(await ko.text()).toContain('<html lang="ko">');
    for (const p of ['/legal/terms', '/legal/ko/privacy', '/legal/notice']) expect((await call(p, {}, RELAY)).status).toBe(404);
    expect((await call('/legal/unknown')).status).toBe(404);
    expect((await call('/legal/ko/unknown')).status).toBe(404);
  });

  it('drafts show the draft banner and marked placeholders', async () => {
    const html = await (await call('/legal/privacy')).text();
    expect(html).toContain('Draft — not yet in force');
    expect(html).toContain('<mark class="todo">');
  });

  it('notice pages carry the full non-affiliation notice in each language', async () => {
    expect(await (await call('/legal/notice')).text()).toContain(NOTICE.en);
    expect(await (await call('/legal/ko/notice')).text()).toContain(NOTICE.ko);
  });

  it('legal pages run no script and every app page has the footer with the notice', async () => {
    const cookie = await loginAs('legal-footer@example.test');
    for (const [p, init] of [['/login', {}], ['/legal/privacy', {}], ['/legal/notice', {}], ['/account', { headers: { cookie } }], ['/checkout?plan=pro-monthly', { headers: { cookie } }]] as const) {
      const r = await call(p, init);
      expect(r.status, p).toBe(200);
      const html = await r.text();
      for (const href of ['/legal/terms', '/legal/privacy', '/legal/refund', '/legal/notice']) expect(html, p).toContain(`href="${href}"`);
      expect(html, p).toContain('not affiliated');
    }
    const csp = (await call('/legal/terms')).headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(await (await call('/legal/terms')).text()).not.toContain('<script');
  });

  it('other app pages stay no-store', async () => {
    expect((await call('/login')).headers.get('cache-control')).toBe('no-store');
  });
});
