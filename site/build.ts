/**
 * Landing-page build: site/content → static HTML, no framework.
 *   npx tsx site/build.ts [--release] [--out <dir>]          (default out: site/dist)
 * Env: SITE_ORIGIN (https, required with --release), AIMSG_INSTALL_READY=1 (required with --release: you checked that
 * the install line really works — npm name and publish), AIMSG_CHECKOUT_PRO_MONTHLY / _YEARLY (optional,
 * both or neither: without them the Pro buttons are marked unavailable — Community launches first; with them every
 * plan4 claim must be checked and moved to shipped first), CF_ANALYTICS_TOKEN (optional).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locale } from '../src/shared/locale';
import { en } from './content/en';
import { ko } from './content/ko';
import { CLAIMS } from './content/claims';
import { checkoutUrls } from './content/pricing';
import type { SiteContent } from './content/types';
import { pagePath, renderPage, type ImageSize } from './render';

const SITE = path.dirname(fileURLToPath(import.meta.url));
const CONTENT: Record<Locale, SiteContent> = { en, ko };
/** Spec §3 rule 4: never on the page. */
export const BANNED = /\bunlimited\b|\bbypass|\bcircumvent|100%\s*quota|무제한|한도\s*우회|할당량\s*100%/i;
/** Cloudflare Pages allows 25 MiB per file; keep the optional demo video well under it. */
const VIDEO_MAX = 20 * 1024 * 1024;

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(buf: Buffer): ImageSize {
  if (buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG' || buf.toString('latin1', 12, 16) !== 'IHDR') throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const walk = (d: string): string[] => fs.existsSync(d)
  ? fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)])
  : [];

function originFrom(v: string | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.pathname === '/' && !u.search && !u.hash ? u.origin : null;
  } catch { return null; }
}

/** The _headers file: the template, plus the Cloudflare beacon's script and connect sources when analytics is on. */
export function headersFor(template: string, analytics: boolean): string {
  if (!analytics) return template;
  const add = (h: string, from: string, to: string) => {
    if (!h.includes(from)) throw new Error(`site/static/_headers: CSP has no "${from}" to extend for analytics`);
    return h.replace(from, to);
  };
  const h = add(add(template, "script-src 'self';", "script-src 'self' https://static.cloudflareinsights.com;"), "default-src 'self';", "default-src 'self'; connect-src 'self' https://cloudflareinsights.com;");
  if (!h.includes("connect-src 'self' https://cloudflareinsights.com;") || !h.includes('script-src \'self\' https://static.cloudflareinsights.com;')) throw new Error('site/static/_headers: CSP was not extended for analytics');
  return h;
}

export async function runBuild(opts: { out: string; release: boolean; env: Record<string, string | undefined> }): Promise<{ out: string }> {
  const { out, release, env } = opts;
  const origin = originFrom(env.SITE_ORIGIN);
  if (env.SITE_ORIGIN && !origin) throw new Error(`SITE_ORIGIN must be an https origin (got ${env.SITE_ORIGIN})`);
  if (release && !origin) throw new Error('--release needs SITE_ORIGIN (an https origin, e.g. https://example.com)');
  if (release && env.AIMSG_INSTALL_READY !== '1') throw new Error('--release needs AIMSG_INSTALL_READY=1: set it only after checking that the install line on the page (npx ai-msg) really installs and starts AI-MSG — the npm package is published under that name');
  const checkout = checkoutUrls(env);
  if (!!checkout.proMonthly !== !!checkout.proYearly) throw new Error('set both AIMSG_CHECKOUT_PRO_MONTHLY and AIMSG_CHECKOUT_PRO_YEARLY (https), or neither');
  const unreleased = Object.entries(CLAIMS).filter(([, c]) => c.owner === 'plan4').map(([id]) => id);
  if (checkout.proMonthly && unreleased.length) throw new Error(`checkout links set, but these Pro claims are still plan4 (not shipped): ${unreleased.join(', ')} — check each against what shipped and mark it shipped (or drop it) first`);
  const analyticsToken = env.CF_ANALYTICS_TOKEN && /^[\w-]{1,128}$/.test(env.CF_ANALYTICS_TOKEN) ? env.CF_ANALYTICS_TOKEN : null;

  const assetsDir = path.join(SITE, 'assets');
  const images: Record<string, ImageSize> = {};
  for (const f of walk(assetsDir).filter((f) => f.endsWith('.png'))) images[path.relative(SITE, f).split(path.sep).join('/')] = pngSize(fs.readFileSync(f));
  const video = path.join(assetsDir, 'demo', 'demo.mp4');
  const hasVideo = fs.existsSync(video);
  if (hasVideo && fs.statSync(video).size > VIDEO_MAX) throw new Error(`demo video over ${VIDEO_MAX / 1024 / 1024} MB: ${video}`);

  const problems: string[] = [];
  for (const [locale, c] of Object.entries(CONTENT) as [Locale, SiteContent][]) {
    for (const f of ['inbox.png', ...c.demo.stills.map((s) => s.file)]) if (!images[`assets/shots/${locale}/${f}`]) problems.push(`missing screenshot assets/shots/${locale}/${f}`);
    if (!images[`assets/og.${locale}.png`]) problems.push(`missing assets/og.${locale}.png`);
    const banned = BANNED.exec(JSON.stringify(c));
    if (banned) problems.push(`banned word in ${locale}: ${banned[0]}`);
  }
  if (problems.length) throw new Error(problems.join('\n'));

  fs.mkdirSync(out, { recursive: true });
  for (const [locale, c] of Object.entries(CONTENT) as [Locale, SiteContent][]) {
    const html = renderPage(c, { locale, origin, checkout, hasVideo, analyticsToken, images });
    const file = path.join(out, pagePath(locale), 'index.html');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html);
  }
  fs.copyFileSync(path.join(SITE, 'styles.css'), path.join(out, 'styles.css'));
  fs.copyFileSync(path.join(SITE, 'static', 'copy.js'), path.join(out, 'copy.js'));
  fs.copyFileSync(path.join(SITE, 'static', 'robots.txt'), path.join(out, 'robots.txt'));
  fs.writeFileSync(path.join(out, '_headers'), headersFor(fs.readFileSync(path.join(SITE, 'static', '_headers'), 'utf8'), analyticsToken !== null));
  fs.cpSync(assetsDir, path.join(out, 'assets'), { recursive: true });
  if (origin) {
    const urls = (Object.keys(CONTENT) as Locale[]).map((l) => `  <url><loc>${origin}${pagePath(l)}</loc></url>`).join('\n');
    fs.writeFileSync(path.join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
    fs.appendFileSync(path.join(out, 'robots.txt'), `Sitemap: ${origin}/sitemap.xml\n`);
  }
  return { out };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  const out = path.resolve(i >= 0 && args[i + 1] ? args[i + 1]! : path.join(SITE, 'dist'));
  runBuild({ out, release: args.includes('--release'), env: process.env })
    .then(() => process.stdout.write(`site: built ${out}\n`))
    .catch((err: unknown) => { process.stderr.write(`site: ${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); });
}
