import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { BANNED, pngSize, runBuild } from './build';
import { escapeHtml } from './render';
import { en as enContent } from './content/en';
import { ko as koContent } from './content/ko';
import { CLAIMS } from './content/claims';
import { INSTALL_COMMAND } from './content/install';
import { PRICING, checkoutUrls } from './content/pricing';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aimsg-site-')); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const read = (out: string, f: string) => fs.readFileSync(path.join(out, f), 'utf8');
const build = async (env: Record<string, string> = {}, release = false) => (await runBuild({ out: tmp(), release, env })).out;
/** Visible text: scripts/styles dropped, tags stripped, entities left as they are (none of them is Hangul). */
const textOf = (html: string) => html.replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ');
const RELEASE_ENV = { SITE_ORIGIN: 'https://example.com' };
const PAGES = ['index.html', 'ko/index.html'] as const;

describe('landing site build', () => {
  it('en and ko pages with all sections and the right lang', async () => {
    const out = await build();
    const en = read(out, 'index.html'), ko = read(out, 'ko/index.html');
    expect(en).toContain('<html lang="en"');
    expect(ko).toContain('<html lang="ko"');
    for (const id of ['hero', 'demo', 'features', 'pricing', 'faq', 'security', 'install']) {
      expect(en).toContain(`id="${id}"`);
      expect(ko).toContain(`id="${id}"`);
    }
    for (const f of ['styles.css', 'copy.js', '_headers', 'robots.txt']) expect(fs.existsSync(path.join(out, f))).toBe(true);
  });

  it('English page has no Hangul except the language switch', async () => {
    const en = read(await build(), 'index.html').replace(enContent.langSwitch, '');
    expect(textOf(en)).not.toMatch(HANGUL);
    expect(en.replace(/>[^<]*</g, '><')).not.toMatch(HANGUL); // attributes (alt, aria-label, content) too
  });

  it('hero is the agent-messenger line, not a general assistant', () => {
    expect(enContent.hero.headline).toMatch(/one inbox/i);
    for (const v of ['Claude Code', 'Codex', 'Gemini', 'Grok']) expect(enContent.hero.headline + enContent.hero.sub).toContain(v);
    expect(enContent.hero.headline + enContent.hero.sub).toMatch(/phone/);
    expect(JSON.stringify(enContent)).not.toMatch(/personal assistant|cockpit/i);
  });

  it('install line is INSTALL_COMMAND verbatim on both pages', async () => {
    const out = await build();
    for (const p of PAGES) {
      const html = read(out, p);
      expect(html).toContain(`<code>${escapeHtml(INSTALL_COMMAND)}</code>`);
      expect(html).toContain(`data-copy="${escapeHtml(INSTALL_COMMAND)}"`);
    }
  });

  it('prices come from PRICING', async () => {
    const out = await build();
    const en = read(out, 'index.html'), ko = read(out, 'ko/index.html');
    const { monthlyUsd, yearlyUsd, foundingYearlyUsd, trialDays } = PRICING.pro;
    for (const html of [en, ko]) for (const n of [monthlyUsd, yearlyUsd, foundingYearlyUsd]) expect(html).toContain(`$${n}`);
    expect(en).toContain(`${trialDays}-day`);
    expect(ko).toContain(`${trialDays}일`);
    expect(PRICING.pro).toEqual({ monthlyUsd: 10, yearlyUsd: 100, foundingYearlyUsd: 80, trialDays: 7, cardRequiredForTrial: false });
  });

  it('Pro is marked coming soon and Community is free', async () => {
    const out = await build();
    expect(read(out, 'index.html')).toMatch(/class="badge soon"[^>]*>Coming soon</);
    expect(read(out, 'ko/index.html')).toMatch(/class="badge soon"[^>]*>출시 예정</);
    expect(enContent.pricing.free.price).toBe('$0');
    expect(koContent.pricing.free.price).toBe('$0');
  });

  it('no banned marketing words in either locale', async () => {
    const out = await build();
    for (const p of PAGES) expect(textOf(read(out, p))).not.toMatch(BANNED);
    expect(JSON.stringify([enContent, koContent])).not.toMatch(BANNED);
  });

  it('buy buttons: data-plan + checkout URL; without one they are unavailable', async () => {
    const pre = read(await build(), 'index.html');
    expect(pre).toMatch(/data-plan="pro-monthly"[^>]*href="#pricing"[^>]*aria-disabled="true"/);
    expect(pre).toMatch(/data-plan="pro-yearly"[^>]*href="#pricing"[^>]*aria-disabled="true"/);
    expect(pre).toContain(enContent.pricing.unavailable);
    const rel = read(await build({ ...RELEASE_ENV, AIMSG_CHECKOUT_PRO_MONTHLY: 'https://pay.example.com/m', AIMSG_CHECKOUT_PRO_YEARLY: 'https://pay.example.com/y' }, true), 'index.html');
    expect(rel).toMatch(/data-plan="pro-monthly"[^>]*href="https:\/\/pay\.example\.com\/m"/);
    expect(rel).toMatch(/data-plan="pro-yearly"[^>]*href="https:\/\/pay\.example\.com\/y"/);
    expect(rel).not.toContain('aria-disabled');
  });

  it('checkout URLs must be https', () => {
    expect(checkoutUrls({ AIMSG_CHECKOUT_PRO_MONTHLY: 'http://pay.example.com/m', AIMSG_CHECKOUT_PRO_YEARLY: 'javascript:alert(1)' })).toEqual({ proMonthly: null, proYearly: null });
    expect(checkoutUrls({ AIMSG_CHECKOUT_PRO_MONTHLY: 'https://pay.example.com/m' })).toEqual({ proMonthly: 'https://pay.example.com/m', proYearly: null });
  });

  it('--release needs SITE_ORIGIN (https) but not checkout URLs (free launch first)', async () => {
    await expect(build({}, true)).rejects.toThrow(/SITE_ORIGIN/);
    await expect(build({ SITE_ORIGIN: 'http://example.com' }, true)).rejects.toThrow(/SITE_ORIGIN/);
    const out = await build(RELEASE_ENV, true);
    const en = read(out, 'index.html');
    expect(en).toContain('<meta property="og:image" content="https://example.com/assets/og.en.png"');
    expect(en).toContain('<link rel="alternate" hreflang="ko" href="https://example.com/ko/"');
    expect(read(out, 'sitemap.xml')).toContain('<loc>https://example.com/ko/</loc>');
    expect(en).toMatch(/data-plan="pro-monthly"[^>]*aria-disabled="true"/);
  });

  it('no external scripts, styles, fonts or images', async () => {
    const out = await build();
    for (const p of PAGES) {
      const html = read(out, p);
      const refs = [...html.matchAll(/<(?:script|img|video|source)\b[^>]*\s(?:src|poster)="([^"]*)"|<link\b[^>]*\shref="([^"]*)"/g)]
        .filter((m) => !/rel="(?:alternate|canonical)"/.test(m[0]))
        .map((m) => m[1] ?? m[2] ?? '');
      expect(refs.length).toBeGreaterThan(2);
      for (const r of refs) expect(r).not.toMatch(/^(?:[a-z]+:)?\/\//i);
    }
    expect(read(out, 'styles.css')).not.toMatch(/@import|url\(\s*['"]?(?:https?:)?\/\//);
  });

  it('every image has alt, width and height, and the file exists with that size', async () => {
    const out = await build();
    for (const p of PAGES) {
      const imgs = [...read(out, p).matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
      expect(imgs.length).toBeGreaterThan(0);
      for (const tag of imgs) {
        const src = /\ssrc="([^"]+)"/.exec(tag)?.[1] ?? '';
        expect(tag, tag).toMatch(/\salt="[^"]*"/);
        if (src.includes('assets/shots/')) expect(tag, tag).toMatch(/\salt="[^"]+"/); // screenshots say what they show; the logo is decorative
        const file = path.join(out, path.dirname(p), src);
        expect(fs.existsSync(file), file).toBe(true);
        const size = pngSize(fs.readFileSync(file));
        expect(tag).toContain(`width="${size.width}"`);
        expect(tag).toContain(`height="${size.height}"`);
      }
    }
  });

  it('shipped PNGs stay under 800 KB', () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.png$/.test(e.name) ? [path.join(d, e.name)] : []);
    const pngs = walk(path.join(ROOT, 'site', 'assets'));
    expect(pngs.length).toBeGreaterThan(0);
    for (const f of pngs) expect(fs.statSync(f).size, f).toBeLessThanOrEqual(800 * 1024);
  });

  it('_headers carries the CSP', async () => {
    const h = read(await build(), '_headers');
    expect(h).toContain("default-src 'self'");
    expect(h).toContain("script-src 'self'");
    expect(h).toContain("frame-ancestors 'none'");
    expect(h).toContain('X-Content-Type-Options: nosniff');
  });

  it('no inline scripts (CSP script-src self)', async () => {
    const out = await build();
    for (const p of PAGES) for (const m of read(out, p).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      expect(m[1]).toMatch(/\ssrc="/);
      expect(m[2]!.trim()).toBe('');
    }
  });

  it('analytics beacon only with a token, and the CSP allows it then', async () => {
    const plain = await build();
    expect(read(plain, 'index.html')).not.toContain('cloudflareinsights');
    const out = await build({ CF_ANALYTICS_TOKEN: 'abc123' });
    expect(read(out, 'index.html')).toContain('static.cloudflareinsights.com/beacon.min.js');
    expect(read(out, '_headers')).toContain('https://static.cloudflareinsights.com');
  });

  it('without a demo video the demo section shows stills, not a <video>', async () => {
    const html = read(await build(), 'index.html');
    const demo = /<section[^>]*id="demo"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(demo).not.toContain('<video');
    expect(demo).toContain('<img');
    expect(enContent.demo.stills.length).toBeGreaterThan(0);
  });

  it('language switch links / and /ko/ with hreflang', async () => {
    const out = await build();
    expect(read(out, 'index.html')).toMatch(/<a [^>]*href="ko\/"[^>]*hreflang="ko"[^>]*>한국어<\/a>/);
    expect(read(out, 'ko/index.html')).toMatch(/<a [^>]*href="\.\.\/"[^>]*hreflang="en"[^>]*>English<\/a>/);
  });

  it('every security point and feature maps to a claim with evidence', () => {
    for (const c of [enContent, koContent]) {
      for (const p of c.security.points) expect(CLAIMS[p.claim]?.evidence, p.claim).toBeTruthy();
      for (const f of c.features.items) {
        const claim = CLAIMS[f.claim];
        expect(claim?.evidence, f.claim).toBeTruthy();
        // Only shipped features outside Pro; Pro (coming soon) carries the next-release ones.
        expect(claim!.owner, f.title).toBe(f.pro ? 'plan4' : 'shipped');
      }
    }
  });

  it('shipped claims cite files that exist', () => {
    for (const [id, c] of Object.entries(CLAIMS)) {
      if (c.owner !== 'shipped') continue;
      const paths = c.evidence.split(/[;,]\s*/).map((s) => s.trim().split(/\s|#/)[0]!).filter((s) => /^(src|scripts|README)/.test(s));
      expect(paths.length, id).toBeGreaterThan(0);
      for (const p of paths) expect(fs.existsSync(path.join(ROOT, p)), `${id}: ${p}`).toBe(true);
    }
  });

  it('license is Apache-2.0 and the name is AI-MSG', async () => {
    const out = await build();
    for (const p of PAGES) {
      const html = read(out, p);
      expect(html).toContain('Apache-2.0');
      expect(html).not.toMatch(/\bMIT\b/);
      expect(html).toContain('AI-MSG');
      expect(html).not.toMatch(/AI msg|Quarterdeck/i);
    }
  });

  it('escapeHtml', () => expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;'));
});
