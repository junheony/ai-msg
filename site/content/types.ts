import type { ClaimId } from './claims';

export type Plan = {
  name: string;
  tagline: string;
  /** "$0" / "$10": built from PRICING in the content files. */
  price: string;
  period: string;
  features: string[];
};

/** One locale of the landing page. `en` is the source; `ko: SiteContent` keeps the keys in step (tsc). */
export type SiteContent = {
  meta: { title: string; description: string; ogAlt: string };
  nav: { label: string; features: string; pricing: string; faq: string; security: string; install: string; skip: string };
  hero: { eyebrow: string; headline: string; sub: string; installLabel: string; copy: string; copied: string; secondaryCta: string; shotAlt: string; note: string };
  demo: { heading: string; caption: string; videoLabel: string; stills: { file: string; alt: string; caption: string }[] };
  features: { heading: string; sub: string; proHeading: string; proBadge: string; items: { title: string; body: string; claim: ClaimId; pro?: boolean }[] };
  pricing: {
    heading: string; sub: string; free: Plan; pro: Plan; freeCta: string; comingSoon: string;
    yearly: string; founding: string; trial: string; buyMonthly: string; buyYearly: string; unavailable: string;
  };
  faq: { heading: string; items: { q: string; a: string }[] };
  security: { heading: string; sub: string; points: { title: string; body: string; claim: ClaimId }[]; more: string };
  install: { heading: string; steps: { title: string; body: string; command?: string }[]; docsLink: string };
  footer: { disclaimer: string; license: string; security: string; source: string };
  langSwitch: string;
};
