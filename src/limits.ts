/**
 * Provider limits (design section 3): the provider's own limit on a key is the hard one, so a paid
 * call to a provider with no declared limit is refused before any spend, and `spend check`
 * compares each declared limit with what the provider reports.
 */
import type { Billing, CallKind, GenerationProvider, LimitReading } from "./gateway/provider.ts";
import { redact } from "./redact.ts";

/** A spend refusal at the provider limit: `provider_limit_undeclared` or `provider_limit_mismatch`. */
export class ProviderLimitError extends Error {
  readonly code: "provider_limit_undeclared" | "provider_limit_mismatch";
  readonly provider: string;
  constructor(
    code: "provider_limit_undeclared" | "provider_limit_mismatch",
    provider: string,
    message: string,
  ) {
    super(redact(message));
    this.name = "ProviderLimitError";
    this.code = code;
    this.provider = provider;
  }
}

/** The billing of every adapter a provider calls through: its parts, or itself. */
export function billingParts(provider: GenerationProvider): readonly Billing[] {
  const parts = (provider as { parts?: readonly Billing[] }).parts;
  return parts ?? [provider.billing];
}

/** The billing a call of this kind is charged to. */
export function billingOf(provider: GenerationProvider, kind: CallKind): Billing {
  return provider.billingFor?.(kind) ?? provider.billing;
}

/**
 * Throws `provider_limit_undeclared` (exit 3) when a paid provider has no declared limit, or
 * declares `unlimited` without `acceptUnlimited`. A free provider needs none.
 */
export function assertLimitDeclared(billing: Billing): void {
  if (!billing.paid) return;
  const limit = billing.limit;
  if (limit === undefined) {
    throw new ProviderLimitError(
      "provider_limit_undeclared",
      billing.providerId,
      `refused: provider "${billing.providerId}" (${billing.adapter}) is paid and declares no limit; set providers.${billing.providerId}.limit in the developer settings to the limit its key carries at the provider`,
    );
  }
  if (limit.kind === "unlimited" && limit.acceptUnlimited !== true) {
    throw new ProviderLimitError(
      "provider_limit_undeclared",
      billing.providerId,
      `refused: provider "${billing.providerId}" declares an unlimited key without acceptUnlimited: true`,
    );
  }
}

/** Every paid part of a provider declares a limit; see `assertLimitDeclared`. */
export function assertLimitsDeclared(provider: GenerationProvider): void {
  for (const billing of billingParts(provider)) assertLimitDeclared(billing);
}

/** One provider's limit as `spend check` reports it. */
export interface LimitCheck {
  provider: string;
  adapter: string;
  paid: boolean;
  declared: boolean;
  limit: Billing["limit"] | null;
  /** True when a reading confirms the declared limit. */
  verified: boolean;
  /** What the provider reported; null when it offers no reading or none was taken. */
  reading: LimitReading | null;
  /** Why the limit is not verified, or why the reading failed. */
  note?: string;
  /** True when the reading contradicts the declared limit. */
  mismatch: boolean;
}

const EPSILON = 1e-9;

/**
 * Compares a declared limit with a reading. A balance verifies only a `prepaid` limit with `usd`:
 * the provider can spend no more than its balance, so a balance at or under the declared amount
 * confirms it and one above contradicts it. Other kinds cannot be confirmed by a balance.
 */
export function compareReading(
  limit: Billing["limit"],
  reading: LimitReading,
): { verified: boolean; mismatch: boolean; note?: string } {
  if (limit === undefined) return { verified: false, mismatch: false, note: "no limit declared" };
  if (reading.balanceUsd === undefined)
    return { verified: false, mismatch: false, note: "the reading has no USD balance" };
  if (limit.kind !== "prepaid" || limit.usd === undefined)
    return {
      verified: false,
      mismatch: false,
      note: `a balance cannot confirm a ${limit.kind} limit`,
    };
  if (reading.balanceUsd > limit.usd + EPSILON)
    return {
      verified: false,
      mismatch: true,
      note: `the provider reports a $${reading.balanceUsd.toFixed(2)} balance, above the declared $${limit.usd.toFixed(2)} prepaid limit`,
    };
  return { verified: true, mismatch: false };
}

/** Checks one provider's declared limit against its reading, when it offers one. */
export async function checkLimit(billing: Billing): Promise<LimitCheck> {
  const base = {
    provider: billing.providerId,
    adapter: billing.adapter,
    paid: billing.paid,
    declared: billing.limit !== undefined,
    limit: billing.limit ?? null,
  };
  if (billing.readLimit === undefined) {
    return {
      ...base,
      verified: false,
      reading: null,
      mismatch: false,
      note: "the provider offers no reading to an ordinary key; declared only",
    };
  }
  let reading: LimitReading;
  try {
    reading = await billing.readLimit();
  } catch (error) {
    return {
      ...base,
      verified: false,
      reading: null,
      mismatch: false,
      note: `reading failed: ${redact(error instanceof Error ? error.message : String(error))}`,
    };
  }
  const compared = compareReading(billing.limit, reading);
  return { ...base, reading, ...compared };
}
