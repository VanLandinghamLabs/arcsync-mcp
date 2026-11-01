/**
 * Every `errorCode` a quota refusal (429 with tier/limit/used/resetAt) carries.
 * Other 429s (PAT pastes, invites, share-link reads) are rate limits, not
 * quotas, and must not open the SPA's quota wall.
 *
 * Kept apart from `quotaLimits` so the SPA's eager api chunk can import the
 * guard without pulling in the tier-limit tables.
 */
export const QUOTA_ERROR_CODES = [
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "DIAGRAM_LIMIT",
  "COST_FREEZE",
  "REPARSE_LIMIT",
  "SYNTH_QUOTA_EXCEEDED",
] as const;

export type QuotaErrorCode = (typeof QUOTA_ERROR_CODES)[number];

export const isQuotaErrorCode = (value: unknown): value is QuotaErrorCode =>
  (QUOTA_ERROR_CODES as readonly unknown[]).includes(value);

const QUOTA_ERROR_SENTENCES: Record<QuotaErrorCode, string> = {
  QUOTA_EXCEEDED: "This workspace has used its monthly parse quota.",
  RATE_LIMITED: "This workspace has reached its hourly parse limit. Try again after the reset.",
  DIAGRAM_LIMIT:
    "This workspace stores as many diagrams as its plan allows. Delete one or reuse an existing diagram.",
  COST_FREEZE: "Parsing is paused for this workspace. Contact ArcSync support to lift it.",
  REPARSE_LIMIT:
    "This repository failed to parse several times in a row. Fix the failure before parsing it again.",
  SYNTH_QUOTA_EXCEEDED: "This workspace has used its monthly CDK/Pulumi synth quota.",
};

/** The human `error` a quota refusal carries next to its machine fields. */
export function quotaErrorMessage(q: {
  errorCode: QuotaErrorCode;
  tier: string;
  limit: number;
  used: number;
  resetAt: string;
}): string {
  const parts = [QUOTA_ERROR_SENTENCES[q.errorCode]];
  // A cost freeze's counters are tenths of a cent, which mean nothing to a reader.
  if (q.errorCode !== "COST_FREEZE") {
    parts.push(`Used ${q.used} of ${q.limit} on the ${q.tier} plan.`);
  }
  if (q.resetAt) parts.push(`Resets at ${q.resetAt}.`);
  return parts.join(" ");
}
