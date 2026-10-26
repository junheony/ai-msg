import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { BANNED, headersFor, pngSize, runBuild } from './build';
import { escapeHtml, renderPage } from './render';
import { en as enContent } from './content/en';
import { ko as koContent } from './content/ko';
import { CLAIMS } from './content/claims';
import { INSTALL_COMMAND, SERVICE_INSTALL_COMMAND } from './content/install';
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
const RELEASE_ENV = { SITE_ORIGIN: 'https://example.com', AIMSG_INSTALL_READY: '1' };
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
    for (const html of [en, ko]) expect(html).toContain(`<span class="amount">$${monthlyUsd}</span>`);
    expect(en).toMatch(new RegExp(`>\\$${monthlyUsd}<`));
    expect(en).toContain(`or $${yearlyUsd} / year`);
    expect(en).toContain(`Founding customers: $${foundingYearlyUsd} / year`);
    expect(ko).toContain(`또는 연 $${yearlyUsd}`);
    expect(ko).toContain(`창립 고객: 연 $${foundingYearlyUsd}`);
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
    // On sale only with both links: then both buttons work, and no "coming soon" / "not on sale" anywhere in pricing.
    const images = new Proxy({}, { get: () => ({ width: 1, height: 1 }) });
    const sale = renderPage(enContent, { locale: 'en', origin: null, checkout: { proMonthly: 'https://pay.example.com/m', proYearly: 'https://pay.example.com/y' }, hasVideo: false, analyticsToken: null, images });
    const pricing = /<section[^>]*id="pricing"[\s\S]*?<\/section>/.exec(sale)?.[0] ?? '';
    expect(pricing).toMatch(/data-plan="pro-monthly"[^>]*href="https:\/\/pay\.example\.com\/m"/);
    expect(pricing).toMatch(/data-plan="pro-yearly"[^>]*href="https:\/\/pay\.example\.com\/y"/);
    expect(pricing).not.toContain('aria-disabled');
    expect(pricing).not.toContain(enContent.pricing.unavailable);
    expect(pricing).not.toContain(enContent.pricing.comingSoon);
    // One link alone is a mistake, not a half-open shop.
    await expect(build({ AIMSG_CHECKOUT_PRO_MONTHLY: 'https://pay.example.com/m' })).rejects.toThrow(/both/);
    // Both links while Pro features are still unreleased (plan4 claims): refused until the claims are checked.
    await expect(build({ AIMSG_CHECKOUT_PRO_MONTHLY: 'https://pay.example.com/m', AIMSG_CHECKOUT_PRO_YEARLY: 'https://pay.example.com/y' })).rejects.toThrow(/plan4/);
  });

  it('checkout URLs must be https', () => {
    expect(checkoutUrls({ AIMSG_CHECKOUT_PRO_MONTHLY: 'http://pay.example.com/m', AIMSG_CHECKOUT_PRO_YEARLY: 'javascript:alert(1)' })).toEqual({ proMonthly: null, proYearly: null });
    expect(checkoutUrls({ AIMSG_CHECKOUT_PRO_MONTHLY: 'https://pay.example.com/m' })).toEqual({ proMonthly: 'https://pay.example.com/m', proYearly: null });
  });

  it('--release needs SITE_ORIGIN (https) and AIMSG_INSTALL_READY=1, but not checkout URLs (free launch first)', async () => {
    await expect(build({ AIMSG_INSTALL_READY: '1' }, true)).rejects.toThrow(/SITE_ORIGIN/);
    await expect(build({ SITE_ORIGIN: 'http://example.com', AIMSG_INSTALL_READY: '1' }, true)).rejects.toThrow(/SITE_ORIGIN/);
    // The install line has to work before the page goes out (npm name and publish).
    await expect(build({ SITE_ORIGIN: 'https://example.com' }, true)).rejects.toThrow(/AIMSG_INSTALL_READY/);
    await expect(build({ SITE_ORIGIN: 'https://example.com', AIMSG_INSTALL_READY: 'yes' }, true)).rejects.toThrow(/AIMSG_INSTALL_READY/);
    await expect(build({}, false)).resolves.toBeTruthy(); // previews do not need it
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
    const h = read(out, '_headers');
    expect(h).toMatch(/script-src 'self' https:\/\/static\.cloudflareinsights\.com;/);
    expect(h).toMatch(/connect-src 'self' https:\/\/cloudflareinsights\.com;/);
    expect(read(plain, '_headers')).not.toContain('connect-src');
    // A template the replacements no longer match fails the build instead of shipping a CSP that blocks the beacon.
    expect(() => headersFor("Content-Security-Policy: default-src 'self'\n", true)).toThrow(/CSP/);
  });

  it('no inline styles or event handlers', async () => {
    const out = await build();
    for (const p of PAGES) {
      const html = read(out, p);
      expect(html).not.toMatch(/<style\b/i);
      expect(html).not.toMatch(/\sstyle=/i);
      expect(html).not.toMatch(/<[^>]+\son[a-z]+=/i);
    }
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

  it('en and ko list the same features and security points in the same order', () => {
    expect(koContent.features.items.map((f) => [f.claim, !!f.pro])).toEqual(enContent.features.items.map((f) => [f.claim, !!f.pro]));
    expect(koContent.security.points.map((p) => p.claim)).toEqual(enContent.security.points.map((p) => p.claim));
  });

  it('Pro (coming soon) is the relay only; push and reminders are Community', () => {
    const plan4 = Object.entries(CLAIMS).filter(([, c]) => c.owner === 'plan4').map(([id]) => id).sort();
    expect(plan4).toEqual(['proRelay', 'proRelayPush', 'relayCiphertext', 'relayMacOnly']);
    for (const c of [enContent, koContent]) {
      const free = c.features.items.filter((f) => !f.pro).map((f) => f.claim);
      expect(free).toEqual(expect.arrayContaining(['pushNotifications', 'reminders']));
    }
    expect(JSON.stringify([enContent, koContent])).not.toMatch(/as many accounts|combined usage|가진 계정 전부|한데 모아/i);
    expect(CLAIMS.pushNotifications.evidence).toContain('src/server/push/SubscriptionStore.ts');
    expect(CLAIMS.reminders.evidence).toContain('src/server/push/BottleneckWatch.ts');
  });

  it('push and reminder copy matches the code (cumulative nudge gaps; only turns that need you)', () => {
    const body = (c: typeof enContent, id: string) => c.features.items.find((f) => f.claim === id)!.body;
    // TURN_NUDGE_GAPS_MS are gaps added up: 10, 10+30, 10+30+60 minutes after the failure.
    expect(body(enContent, 'reminders')).toMatch(/10, 40 and 100 minutes/);
    expect(body(koContent, 'reminders')).toMatch(/10분·40분·100분/);
    expect(CLAIMS.reminders.text).toMatch(/10, 40 and 100 minutes/);
    // turnNeedsAttention: a quiet success is not pushed.
    expect(JSON.stringify([enContent, koContent, CLAIMS.pushNotifications])).not.toMatch(/turn finishes|턴이 끝나/);
    expect(body(enContent, 'pushNotifications')).toMatch(/fails, runs long or ends with a question/);
    expect(body(koContent, 'pushNotifications')).toMatch(/실패했거나 오래 걸렸거나 질문으로 끝/);
  });

  it('claims and site sources carry no internal plan labels; en Pro items are future tense', () => {
    for (const [id, c] of Object.entries(CLAIMS)) expect(`${c.text} ${c.evidence}`, id).not.toMatch(/plan ?[①-⑨0-9]|\bD\d+\b|\bTask\b|Review Focus/);
    for (const f of ['build.ts', 'render.ts', 'content/claims.ts', 'content/install.ts', 'content/pricing.ts', 'content/en.ts', 'content/ko.ts', 'demo/shotlist.md']) {
      expect(fs.readFileSync(path.join(ROOT, 'site', f), 'utf8'), f).not.toMatch(/plan ?[①-⑨]|\bD\d{1,2}\b|\bTask \d|Review Focus/);
    }
    for (const f of enContent.features.items.filter((i) => i.pro)) expect(f.body, f.title).toMatch(/\bwill\b/);
  });

  it('unreleased (plan4) items carry a coming-soon mark on the page; ko says them in the future tense', async () => {
    const out = await build();
    for (const [p, c] of [['index.html', enContent], ['ko/index.html', koContent]] as const) {
      const html = read(out, p);
      const pro = /<h3 class="pro-head">[\s\S]*?<\/h3>\s*<ul class="grid pro">([\s\S]*?)<\/ul>/.exec(html);
      expect(pro?.[0]).toContain(`class="badge soon">${escapeHtml(c.features.proBadge)}<`);
      for (const f of c.features.items) expect(pro![1]!.includes(`data-claim="${f.claim}"`), f.claim).toBe(!!f.pro);
      for (const s of c.security.points) {
        const li = new RegExp(`<li data-claim="${s.claim}">[\\s\\S]*?</li>`).exec(html)?.[0] ?? '';
        expect(li.includes('class="badge soon"'), s.claim).toBe(CLAIMS[s.claim].owner === 'plan4');
      }
    }
    const later = [...koContent.features.items.filter((f) => f.pro).map((f) => f.body), ...koContent.security.points.filter((s) => CLAIMS[s.claim].owner === 'plan4').map((s) => s.body)];
    expect(later.length).toBeGreaterThan(0);
    for (const b of later) expect(b, b).toMatch(/예정/);
  });

  it('approvals are described engine by engine (Codex has no approval cards)', () => {
    const approvals = (c: typeof enContent) => [c.features.items.find((f) => f.claim === 'approvals')!.body, c.security.points.find((s) => s.claim === 'engineApprovals')!.body];
    for (const b of approvals(enContent)) {
      expect(b).toMatch(/Claude Code and Grok ask/);
      expect(b).toMatch(/Codex[^.]*no approval cards/);
      expect(b).toMatch(/sandbox/);
    }
    for (const b of approvals(koContent)) {
      expect(b).toMatch(/Claude Code·Grok/);
      expect(b).toMatch(/Codex[^.]*승인 카드 없이/);
      expect(b).toMatch(/샌드박스/);
    }
    expect(JSON.stringify([enContent, koContent])).not.toMatch(/New sessions ask before|새 세션은 (?:도구를 쓰기 전에|결정이 필요한 도구 호출마다) 묻/);
    for (const id of ['approvals', 'engineApprovals'] as const) {
      expect(CLAIMS[id].evidence).toContain('src/server/engine/CodexEngine.ts');
      expect(CLAIMS[id].evidence).toContain('src/server/engine/GrokEngine.ts');
      // Gemini read-only comes from headless denial (--mode plan has no effect), as measured.
      expect(CLAIMS[id].evidence).toContain('docs/gemini-spike.md');
      expect(CLAIMS[id].evidence).toContain('src/server/engine/fixtures/agy-1.4.2/04-plan-write-denied.jsonl');
      expect(CLAIMS[id].evidence).toContain('src/server/engine/fixtures/agy-1.4.2/06-resume-shell-denied.jsonl');
      expect(CLAIMS[id].evidence).not.toMatch(/plan = read-only/);
    }
  });

  it('FAQ says where code goes and whose job the terms are; phone access is over Tailscale', () => {
    const faq = (c: typeof enContent, re: RegExp) => c.faq.items.find((q) => re.test(q.q))!.a;
    const code = faq(enContent, /code/i);
    expect(code).not.toMatch(/^No\b/);
    expect(code).toMatch(/vendor/);
    expect(code).toMatch(/carr(?:y|ies) on/);
    expect(faq(koContent, /코드/)).toMatch(/벤더/);
    expect(faq(enContent, /terms/)).toContain('complies with each service’s terms is your responsibility');
    expect(faq(koContent, /약관/)).toContain('각 서비스의 약관에 맞는지는 사용자 책임');
    expect(JSON.stringify([enContent, koContent])).not.toMatch(/own network|내 네트워크/);
    expect(enContent.features.items.find((f) => f.claim === 'phoneWeb')!.body).toMatch(/over Tailscale/);
  });

  it('install steps include the service command', async () => {
    const out = await build();
    expect(SERVICE_INSTALL_COMMAND).toBe('ai-msg service install');
    for (const p of PAGES) expect(read(out, p)).toContain(`<code>${escapeHtml(SERVICE_INSTALL_COMMAND)}</code>`);
  });

  it('nav is labelled and stays reachable on phones; copy result is announced; ko keeps words whole', async () => {
    const out = await build();
    expect(read(out, 'index.html')).toContain('<nav aria-label="Sections">');
    expect(read(out, 'ko/index.html')).toContain('<nav aria-label="섹션">');
    for (const p of PAGES) expect(read(out, p)).toMatch(/<[^>]+id="copy-status"[^>]*aria-live="polite"/);
    expect(read(out, 'copy.js')).toContain('copy-status');
    const css = read(out, 'styles.css');
    expect(css).not.toMatch(/\.top nav\s*\{\s*display:\s*none/);
    expect(css).toMatch(/:lang\(ko\)[^{]*\{[^}]*word-break:\s*keep-all/);
  });

  it('shipped claims cite files that exist', () => {
    for (const [id, c] of Object.entries(CLAIMS)) {
      if (c.owner !== 'shipped') continue;
      const paths = c.evidence.split(/[;,]\s*/).map((s) => s.trim().split(/\s|#/)[0]!).filter((s) => /^(src|scripts|docs|README)/.test(s));
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

describe('README and install guide', () => {
  const doc = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const EN = ['README.md', 'docs/install.md'] as const;
  const KO = ['README.ko.md', 'docs/install.ko.md'] as const;
  const ALL = [...EN, ...KO];
  /** The one line to delete once the package is on npm (same marker in every doc). */
  const NOT_ON_NPM = /^.*<!-- npm-pending -->.*$/gm;

  it('every doc gives INSTALL_COMMAND as the install line, with the one-line not-on-npm-yet note linking CONTRIBUTING', () => {
    for (const f of ALL) {
      const s = doc(f);
      expect(s, f).toMatch(new RegExp(`^${INSTALL_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
      const notes = s.match(NOT_ON_NPM) ?? [];
      expect(notes, f).toHaveLength(1);
      expect(notes[0], f).toMatch(/CONTRIBUTING\.md#/);
    }
    // Deleting that line leaves a working guide: no other text depends on it.
    for (const f of ALL) expect(doc(f).replace(NOT_ON_NPM, ''), f).not.toMatch(/npm-pending|not on npm|npm 에 아직/i);
  });

  it('English docs have no Hangul except the language link', () => {
    for (const f of EN) expect(doc(f).replace(/\[한국어\]\([^)]+\)/g, ''), f).not.toMatch(HANGUL);
  });

  it('no banned words, old names, SDK wording, repo-only service script, internal plan labels or personal paths', () => {
    for (const f of ALL) {
      const s = doc(f);
      expect(s, f).not.toMatch(BANNED);
      expect(s, f).not.toMatch(/quarterdeck|Agent SDK|install-launchd\.sh/i);
      expect(s, f).not.toMatch(/plan ?[①-⑨]|\bD\d{1,2}\b|\bTask \d|Review Focus/);
      expect(s, f).not.toMatch(/\/Users\/(?!alice\b)|Documents\/개발/);
    }
  });

  it('README opens as the agent messenger, not an account rotator; multiple accounts is one feature', () => {
    for (const f of ['README.md', 'README.ko.md']) {
      const s = doc(f);
      const head = s.slice(0, s.indexOf('\n## '));
      expect(head, f).toMatch(/Claude Code/);
      for (const v of ['Codex', 'Gemini', 'Grok']) expect(head, f).toContain(v);
      expect(head, f).not.toMatch(/account|seat|계정|좌석/i);
    }
    expect(doc('README.md').slice(0, doc('README.md').indexOf('\n## '))).toMatch(/one inbox/i);
    expect(doc('README.ko.md').slice(0, doc('README.ko.md').indexOf('\n## '))).toMatch(/받은편지함/);
  });

  it('package.json description says the same thing', () => {
    const pkg = JSON.parse(doc('package.json')) as { description: string; private?: boolean };
    expect(pkg.description).toMatch(/one inbox/i);
    for (const v of ['Claude Code', 'Codex', 'Gemini', 'Grok', 'phone']) expect(pkg.description).toContain(v);
    expect(pkg.description).not.toMatch(/routes? turns|accounts/i);
    expect(pkg.private).toBe(true); // stays until the npm name is secured
  });

  it('Community is free under Apache-2.0; Pro is coming soon, the relay only, at PRICING', () => {
    const { monthlyUsd, yearlyUsd } = PRICING.pro;
    for (const f of ['README.md', 'README.ko.md']) {
      const s = doc(f);
      expect(s, f).toContain('Apache-2.0');
      expect(s, f).not.toMatch(/\bMIT\b/);
      expect(s, f).toContain(`$${monthlyUsd}`);
      expect(s, f).toContain(`$${yearlyUsd}`);
    }
    const pro = /\n## Pro[^\n]*\n([\s\S]*?)\n## /.exec(doc('README.md'))?.[1] ?? '';
    expect(pro).toMatch(/coming soon/i);
    expect(pro).toMatch(/relay/);
    expect(pro).not.toMatch(/This release has/);
    expect(/\n## Pro[^\n]*\n([\s\S]*?)\n## /.exec(doc('README.ko.md'))?.[1] ?? '').toMatch(/출시 예정/);
  });

  it('approvals engine by engine, phone over Tailscale, code goes to the vendor, terms are the user’s', () => {
    const en = doc('README.md');
    expect(en).toMatch(/Claude Code and Grok ask/);
    expect(en).toMatch(/Codex[^.]*no approval cards/);
    expect(en).toMatch(/Gemini[^.]*read-only/);
    expect(en).toMatch(/over Tailscale/);
    expect(en).toMatch(/vendor of the CLI/);
    expect(en).toContain('complies with each service’s terms is your responsibility');
    expect(en).toContain('## Remote access'); // CLAIMS cite README.md#remote-access
    const ko = doc('README.ko.md');
    expect(ko).toMatch(/Codex[^.]*승인 카드 없이/);
    expect(ko).toContain('각 서비스의 약관에 맞는지는 사용자 책임');
  });

  it('every ai-msg command in the docs parses (src/server/cli/args.ts)', async () => {
    const { parseCli } = await import('../src/server/cli/args');
    const seen: string[] = [];
    for (const f of ALL) {
      const s = doc(f);
      const lines = [
        ...[...s.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)].flatMap((m) => m[1]!.split('\n')),
        ...[...s.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!),
      ];
      for (const raw of lines) {
        // `npx ai-msg` / `npm i -g ai-msg@latest` name the package, not a command.
        const line = raw.replace(/\s+#.*$/, '').replace(/\b(?:npx|npm i(?:nstall)? -g)\s+ai-msg(?:@\S+)?/g, '').trim();
        const m = /(?:^|\s)ai-msg((?:\s+[^\s;&|]+)*)/.exec(line);
        if (!m) continue;
        const argv = m[1]!.trim().split(/\s+/).filter(Boolean)
          .map((a) => a.replace(/^\[|\]$/g, '').replace(/^<[^>]+>$/, '/x').replace(/^N$/, '5'));
        const cmd = parseCli(argv);
        expect(cmd.kind, `${f}: ${line}`).not.toBe('error');
        seen.push(argv[0] ?? 'start');
      }
    }
    for (const c of ['doctor', 'login-url', 'service']) expect(seen).toContain(c);
  });
});
