/** Spec §0 / §4 (2026-10-27): Pro $10 a month, $100 a year ($80 for founding customers), 7-day trial without a card. */
export const PRICING = { pro: { monthlyUsd: 10, yearlyUsd: 100, foundingYearlyUsd: 80, trialDays: 7, cardRequiredForTrial: false } } as const;

export type Checkout = { proMonthly: string | null; proYearly: string | null };

const https = (v: string | undefined): string | null => {
  if (!v) return null;
  try { return new URL(v).protocol === 'https:' ? v : null; } catch { return null; }
};

/** Checkout links from the build environment (set when Pro goes on sale); anything but an https URL is no link. */
export function checkoutUrls(env: Record<string, string | undefined>): Checkout {
  return { proMonthly: https(env.AIMSG_CHECKOUT_PRO_MONTHLY), proYearly: https(env.AIMSG_CHECKOUT_PRO_YEARLY) };
}
