/**
 * Single source of truth for the per-tier quota matrix.
 *
 * Defaults live here so any consumer (backend Lambda, CDK stack, frontend
 * pricing page, marketing copy generator) can import from one place. Runtime
 * overrides happen at the boundary:
 *   - Backend Lambdas read individual env vars (`FREE_PARSES_PER_MONTH`, etc.)
 *     and fall through to these defaults when unset. The CDK stack populates
 *     those env vars from `cdk.json` context (or its own defaults).
 *   - Frontend imports the defaults directly. Build-time overrides via Vite
 *     env vars (e.g. `VITE_FREE_PARSES_PER_MONTH`) are layered on top in the
 *     consumer.
 *
 * Adding a new tier: extend `Tier` in `types.ts` and add an entry below.
 */

export type Tier = "free" | "pro" | "team" | "enterprise";

/**
 * Limits server synths to paid plans when true. Lifted 2026-11-07. The sandbox
 * router's gate and the pricing copy read it; static docs cannot, so turning it
 * back on means repeating #2817's copy changes (file list in conventions.md).
 */
export const SERVER_SYNTHS_PAID_ONLY: boolean = false;

export interface TierLimits {
  parsesPerMonth: number;
  parsesPerHour: number;
  storedDiagrams: number;
  /**
   * CDK/Pulumi projects ArcSync synthesizes server-side. Metered separately
   * from `parsesPerMonth` because a sandbox synth costs ~$0.011 against a
   * non-sandbox parse's ~$0.00008 — a 100x spread that a single counter
   * cannot price. Consumed by the sandbox router, which is the only place
   * that knows the project type (detection happens after the clone).
   */
  serverSynthsPerMonth: number;
  costCapTenths: number; // tenths of a US cent; $5.00 = 5000
}

const PRO: TierLimits = {
  parsesPerMonth: 1000,
  parsesPerHour: 30,
  storedDiagrams: 100,
  serverSynthsPerMonth: 300,
  costCapTenths: 50_000, // $50/mo
};

export const DEFAULT_TIER_LIMITS: Record<Tier, TierLimits> = {
  free: {
    parsesPerMonth: 100,
    parsesPerHour: 10,
    storedDiagrams: 20,
    serverSynthsPerMonth: 10,
    costCapTenths: 1_000, // $1/mo
  },
  pro: PRO,
  // Per-seat, not per-org. A one-seat org's limits ARE these numbers, so every
  // existing reader stays correct; `scaleForSeats` multiplies up from here.
  // Decided 2026-09-07 (spec §6.3). costCapTenths is deliberately BELOW Pro's:
  // it is blast radius, not a promise — pooled, one member can freeze the whole
  // org, and $50/seat against $49/seat of revenue is break-even at the cap.
  team: {
    parsesPerMonth: 1000,
    parsesPerHour: 30,
    storedDiagrams: 100,
    serverSynthsPerMonth: 300,
    costCapTenths: 25_000, // $25/mo per seat
  },
  enterprise: PRO,
};

/**
 * Hourly burst is a rate limit, not a monthly budget, so it does not scale
 * linearly with seats: 20 seats at 30/hour would be a 600/hour door for a
 * runaway CI loop. Capped instead.
 */
export const TEAM_BURST_CEILING = 200;

/**
 * The pooled limits for an org of `seats` seats, from a per-seat allowance.
 *
 * Buying a seat buys capacity — a flat pooled number cannot coexist with
 * per-seat billing, since a 20-seat team would pay $980/month and share the
 * same 1,000 parses one Pro user gets for $19.
 *
 * A seat count that is not a positive integer floors to 1. Scaling by a
 * garbage value is how a quota gate silently becomes either infinite or zero,
 * and one seat is the safe reading of "we do not know".
 *
 * The `TEAM_BURST_CEILING` clamp applies even at one seat, so it is the one
 * limit an operator's `TEAM_PARSES_PER_HOUR` override cannot raise per stage:
 * a value above the ceiling is silently clamped back down with no error.
 * Lowering it still works as intended; only raising it is a no-op.
 */
export function scaleForSeats(perSeat: TierLimits, seats: number): TierLimits {
  const n = Number.isInteger(seats) && seats > 0 ? seats : 1;
  return {
    parsesPerMonth: perSeat.parsesPerMonth * n,
    parsesPerHour: Math.min(perSeat.parsesPerHour * n, TEAM_BURST_CEILING),
    storedDiagrams: perSeat.storedDiagrams * n,
    serverSynthsPerMonth: perSeat.serverSynthsPerMonth * n,
    costCapTenths: perSeat.costCapTenths * n,
  };
}
