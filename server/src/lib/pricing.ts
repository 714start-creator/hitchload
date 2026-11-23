import type { Config } from '../config.js';

export type Size = 'S' | 'M' | 'L' | 'XL' | 'AUTO';
export const SIZES: Size[] = ['S', 'M', 'L', 'XL', 'AUTO'];

// Starting tariffs (CAD). Tune them in one place; clients may still set their own price.
const CITY_BASE: Record<Size, number> = { S: 15, M: 25, L: 75, XL: 120, AUTO: 150 };
const CITY_PER_KM_OVER_10: Record<Size, number> = { S: 0.6, M: 0.8, L: 1.5, XL: 2.0, AUTO: 2.5 };
const INTERCITY_BASE: Record<Size, number> = { S: 20, M: 30, L: 60, XL: 90, AUTO: 150 };
const INTERCITY_PER_KM: Record<Size, number> = { S: 0.12, M: 0.22, L: 0.45, XL: 0.7, AUTO: 1.1 };

const round5 = (dollars: number) => Math.max(5, Math.round(dollars / 5) * 5);

/** Suggested driver price in cents. */
export function suggestPriceCents(size: Size, km: number, intercity: boolean): number {
  const dollars = intercity
    ? INTERCITY_BASE[size] + km * INTERCITY_PER_KM[size]
    : CITY_BASE[size] + Math.max(0, km - 10) * CITY_PER_KM_OVER_10[size];
  return round5(dollars) * 100;
}

/** Price when riding along with a driver's published trip. */
export function tripPriceCents(size: Size, km: number, rules: Config['rules']): number {
  return round5((suggestPriceCents(size, km, true) / 100) * (1 - rules.tripDiscount)) * 100;
}

export function insuranceCents(declaredValueCents: number, rules: Config['rules']): number {
  return Math.max(rules.insuranceMinCents, Math.round(declaredValueCents * rules.insuranceRate));
}

export interface Breakdown {
  driverPriceCents: number;
  clientFeeCents: number;
  insuranceCents: number;
  clientTotalCents: number;
  driverFeeCents: number;
  driverNetCents: number;
}

export function breakdown(driverPriceCents: number, insured: boolean, declaredValueCents: number, rules: Config['rules']): Breakdown {
  const clientFeeCents = Math.round(driverPriceCents * rules.clientFeeRate);
  const driverFeeCents = Math.round(driverPriceCents * rules.driverFeeRate);
  const ins = insured ? insuranceCents(declaredValueCents, rules) : 0;
  return {
    driverPriceCents,
    clientFeeCents,
    insuranceCents: ins,
    clientTotalCents: driverPriceCents + clientFeeCents + ins,
    driverFeeCents,
    driverNetCents: driverPriceCents - driverFeeCents,
  };
}

export type CancelTier = 'free' | 'early' | 'late' | 'no_show';

export interface CancelSplit {
  tier: CancelTier;
  driverCents: number;
  platformCents: number;
  /** service fee is kept once the card was charged; insurance premium is refunded unless the trip started */
  keptFeeCents: number;
  refundCents: number;
}

/**
 * How a client cancellation is split. `chargedCents` is what was taken from the card.
 * - free: before a driver confirmed (nothing was charged)
 * - early: confirmed, more than `cancelLateHours` before the loading window
 * - late: less than that, or the driver has already set off
 * - no_show: driver arrived and there was no cargo, or it did not match the description
 */
export function cancelSplit(
  o: { status: string; agreedCents: number | null; clientFeeCents: number | null; insuranceCents: number; chargedCents: number | null; windowStart: string },
  now: Date,
  rules: Config['rules'],
  opts: { noShow?: boolean; driverSetOff?: boolean } = {},
): CancelSplit {
  const noShow = opts.noShow ?? false;
  if (o.status === 'open' || !o.agreedCents || !o.chargedCents) {
    return { tier: 'free', driverCents: 0, platformCents: 0, keptFeeCents: 0, refundCents: o.chargedCents ?? 0 };
  }
  const hoursLeft = (new Date(o.windowStart).getTime() - now.getTime()) / 3_600_000;
  const started = o.status === 'picked_up' || o.status === 'in_transit';
  const tier: CancelTier = noShow ? 'no_show' : started || opts.driverSetOff || hoursLeft < rules.cancelLateHours ? 'late' : 'early';
  const p = o.agreedCents;
  const [dr, pr] =
    tier === 'no_show'
      ? [rules.noShowDriverRate, rules.noShowPlatformRate]
      : tier === 'late'
        ? [rules.cancelLateDriverRate, rules.cancelLatePlatformRate]
        : [rules.cancelEarlyDriverRate, rules.cancelEarlyPlatformRate];
  const driverCents = Math.round(p * dr);
  const platformCents = Math.round(p * pr);
  const keptFeeCents = o.clientFeeCents ?? 0;
  const keptInsurance = started ? o.insuranceCents : 0;
  const refundCents = Math.max(0, o.chargedCents - driverCents - platformCents - keptFeeCents - keptInsurance);
  return { tier, driverCents, platformCents, keptFeeCents: keptFeeCents + keptInsurance, refundCents };
}

/** Cargo value limit a driver may carry for this order. */
export function cargoLimitCents(
  driver: { tier: 'basic' | 'pro'; cargoLimitCents: number },
  orderInsured: boolean,
  rules: Config['rules'],
): number {
  // Pro drivers take any order, whatever the item is worth
  if (driver.tier === 'pro') return Number.POSITIVE_INFINITY;
  return orderInsured ? rules.basicInsuredCargoLimitCents : rules.basicCargoLimitCents;
}

export const fmtCad = (cents: number) => `$${(cents / 100).toFixed(2)}`;
