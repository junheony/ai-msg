import type { Locale } from '../src/shared/locale';
import type { Checkout } from './content/pricing';
import type { Plan, SiteContent } from './content/types';
import { CLAIMS } from './content/claims';
import { REPO_URL } from './content/install';

export type ImageSize = { width: number; height: number };
export type RenderContext = {
  locale: Locale;
  /** https origin without a trailing slash (release builds); null = relative links only. */
  origin: string | null;
  checkout: Checkout;
  hasVideo: boolean;
  analyticsToken: string | null;
  /** Pixel size of each image the page uses, keyed by its path under the site root (`assets/…`). */
  images: Record<string, ImageSize>;
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const e = escapeHtml;

/** Path of a locale's page under the site root: `/` for English, `/ko/` for Korean. */
export const pagePath = (l: Locale) => (l === 'en' ? '/' : `/${l}/`);

export function renderPage(c: SiteContent, ctx: RenderContext): string {
  const { locale, origin } = ctx;
  const root = locale === 'en' ? '' : '../';
  const other: Locale = locale === 'en' ? 'ko' : 'en';
  const abs = (p: string) => (origin ? `${origin}${p}` : null);

  const img = (asset: string, alt: string, attrs = '') => {
    const size = ctx.images[asset];
    if (!size) throw new Error(`missing image: ${asset}`);
    return `<img src="${e(root + asset)}" alt="${e(alt)}" width="${size.width}" height="${size.height}"${attrs}>`;
  };
  const shot = (file: string) => `assets/shots/${locale}/${file}`;
  const codeLine = (cmd: string, label: string) =>
    `<div class="cmd"><code>${e(cmd)}</code><button type="button" class="copy" data-copy="${e(cmd)}" data-copied="${e(c.hero.copied)}" aria-label="${e(label)}">${e(c.hero.copy)}</button></div>`;

  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${e(c.meta.title)}</title>`,
    `<meta name="description" content="${e(c.meta.description)}">`,
    '<meta name="color-scheme" content="dark light">',
    `<link rel="stylesheet" href="${root}styles.css">`,
    `<link rel="icon" type="image/png" href="${root}assets/icon.png">`,
    origin ? `<link rel="canonical" href="${e(abs(pagePath(locale))!)}">` : '',
    `<link rel="alternate" hreflang="en" href="${e(abs('/') ?? (root || './'))}">`,
    `<link rel="alternate" hreflang="ko" href="${e(abs('/ko/') ?? `${root}ko/`)}">`,
    `<link rel="alternate" hreflang="x-default" href="${e(abs('/') ?? (root || './'))}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${e(c.meta.title)}">`,
    `<meta property="og:description" content="${e(c.meta.description)}">`,
    `<meta property="og:locale" content="${locale === 'en' ? 'en_US' : 'ko_KR'}">`,
    origin ? `<meta property="og:url" content="${e(abs(pagePath(locale))!)}">` : '',
    origin ? `<meta property="og:image" content="${e(abs(`/assets/og.${locale}.png`)!)}">` : `<meta property="og:image" content="${root}assets/og.${locale}.png">`,
    `<meta property="og:image:alt" content="${e(c.meta.ogAlt)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<script src="${root}copy.js" defer></script>`,
    ctx.analyticsToken ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon="${e(JSON.stringify({ token: ctx.analyticsToken }))}"></script>` : '',
  ].filter(Boolean).join('\n');

  const nav = `<header class="top"><div class="wrap bar">
<a class="brand" href="#hero">${img('assets/icon.png', '', ' class="logo"')}<span>AI-MSG</span></a>
<nav aria-label="${e(c.nav.label)}"><a href="#features">${e(c.nav.features)}</a><a href="#pricing">${e(c.nav.pricing)}</a><a href="#security">${e(c.nav.security)}</a><a href="#faq">${e(c.nav.faq)}</a><a href="#install">${e(c.nav.install)}</a></nav>
<a class="lang" href="${locale === 'en' ? 'ko/' : '../'}" hreflang="${other}" lang="${other}">${e(c.langSwitch)}</a>
</div></header>`;

  const hero = `<section id="hero" class="hero"><div class="wrap">
<p class="eyebrow">${e(c.hero.eyebrow)}</p>
<h1>${e(c.hero.headline)}</h1>
<p class="sub">${e(c.hero.sub)}</p>
<div class="cta">${codeLine(c.install.steps[0]?.command ?? '', c.hero.installLabel)}<a class="btn ghost" href="${REPO_URL}">${e(c.hero.secondaryCta)}</a></div>
<p class="note">${e(c.hero.note)}</p>
<figure class="hero-shot">${img(shot('inbox.png'), c.hero.shotAlt, ' fetchpriority="high"')}</figure>
</div></section>`;

  const stills = c.demo.stills.map((s) => `<figure>${img(shot(s.file), s.alt, ' loading="lazy"')}<figcaption>${e(s.caption)}</figcaption></figure>`).join('\n');
  const demoBody = ctx.hasVideo
    ? `<video controls preload="none" poster="${root}${shot('inbox.png')}" aria-label="${e(c.demo.videoLabel)}"><source src="${root}assets/demo/demo.mp4" type="video/mp4"></video>`
    : `<div class="stills">${stills}</div>`;
  const demo = `<section id="demo"><div class="wrap">
<h2>${e(c.demo.heading)}</h2>
${demoBody}
<p class="caption">${e(c.demo.caption)}</p>
</div></section>`;

  const soon = ` <span class="badge soon">${e(c.features.proBadge)}</span>`;
  const feature = (f: SiteContent['features']['items'][number]) => `<li data-claim="${e(f.claim)}"><h3>${e(f.title)}</h3><p>${e(f.body)}</p></li>`;
  const free = c.features.items.filter((f) => !f.pro), pro = c.features.items.filter((f) => f.pro);
  const features = `<section id="features"><div class="wrap">
<h2>${e(c.features.heading)}</h2>
<p class="lead">${e(c.features.sub)}</p>
<ul class="grid">${free.map(feature).join('\n')}</ul>
<h3 class="pro-head">${e(c.features.proHeading)}${soon}</h3>
<ul class="grid pro">${pro.map(feature).join('\n')}</ul>
</div></section>`;

  const p = c.pricing;
  const planHead = (plan: Plan, badge = '') => `<h3>${e(plan.name)}${badge}</h3><p class="tagline">${e(plan.tagline)}</p>
<p class="price"><span class="amount">${e(plan.price)}</span> <span class="period">${e(plan.period)}</span></p>`;
  const planList = (plan: Plan) => `<ul class="checks">${plan.features.map((f) => `<li>${e(f)}</li>`).join('')}</ul>`;
  const buy = (plan: 'pro-monthly' | 'pro-yearly', url: string | null, label: string) => url
    ? `<a class="btn buy" data-plan="${plan}" href="${e(url)}">${e(label)}</a>`
    : `<a class="btn buy" data-plan="${plan}" href="#pricing" aria-disabled="true">${e(label)}</a>`;
  // On sale only with both links (the build refuses one alone): then both buttons work and nothing says "coming soon".
  const onSale = !!ctx.checkout.proMonthly && !!ctx.checkout.proYearly;
  const link = (u: string | null) => (onSale ? u : null);
  const pricing = `<section id="pricing"><div class="wrap">
<h2>${e(p.heading)}</h2>
<p class="lead">${e(p.sub)}</p>
<div class="plans">
<article class="plan">${planHead(p.free)}${planList(p.free)}<a class="btn primary" href="#install">${e(p.freeCta)}</a></article>
<article class="plan pro">${planHead(p.pro, onSale ? '' : ` <span class="badge soon">${e(p.comingSoon)}</span>`)}
<p class="terms">${e(p.yearly)} · ${e(p.founding)}<br>${e(p.trial)}</p>
${planList(p.pro)}
<div class="buys">${buy('pro-monthly', link(ctx.checkout.proMonthly), p.buyMonthly)}${buy('pro-yearly', link(ctx.checkout.proYearly), p.buyYearly)}</div>
${onSale ? '' : `<p class="unavailable">${e(p.unavailable)}</p>`}
</article>
</div>
</div></section>`;

  const security = `<section id="security"><div class="wrap">
<h2>${e(c.security.heading)}</h2>
<p class="lead">${e(c.security.sub)}</p>
<ul class="grid">${c.security.points.map((s) => `<li data-claim="${e(s.claim)}"><h3>${e(s.title)}${CLAIMS[s.claim].owner === 'plan4' ? soon : ''}</h3><p>${e(s.body)}</p></li>`).join('\n')}</ul>
<p><a href="${REPO_URL}/blob/main/SECURITY.md">${e(c.security.more)}</a></p>
</div></section>`;

  const faq = `<section id="faq"><div class="wrap narrow">
<h2>${e(c.faq.heading)}</h2>
${c.faq.items.map((q) => `<details><summary>${e(q.q)}</summary><p>${e(q.a)}</p></details>`).join('\n')}
</div></section>`;

  const install = `<section id="install"><div class="wrap narrow">
<h2>${e(c.install.heading)}</h2>
<ol class="steps">${c.install.steps.map((s) => `<li><h3>${e(s.title)}</h3><p>${e(s.body)}</p>${s.command ? codeLine(s.command, c.hero.installLabel) : ''}</li>`).join('\n')}</ol>
<p><a href="${REPO_URL}#readme">${e(c.install.docsLink)}</a></p>
</div></section>`;

  const footer = `<footer><div class="wrap">
<p>${e(c.footer.disclaimer)}</p>
<p class="links"><a href="${REPO_URL}">${e(c.footer.source)}</a> · <a href="${REPO_URL}/blob/main/LICENSE">${e(c.footer.license)}</a> · <a href="${REPO_URL}/blob/main/SECURITY.md">${e(c.footer.security)}</a></p>
</div></footer>`;

  return `<!doctype html>
<html lang="${locale}">
<head>
${head}
</head>
<body>
<a class="skip" href="#main">${e(c.nav.skip)}</a>
${nav}
<main id="main">
${hero}
${demo}
${features}
${pricing}
${security}
${faq}
${install}
</main>
${footer}
<p id="copy-status" class="sr-only" role="status" aria-live="polite"></p>
</body>
</html>
`;
}
