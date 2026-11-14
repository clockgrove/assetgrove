/**
 * Provider limits (design section 3): a paid call to a provider with no declared `limit` is
 * refused before spend, and `spend check` compares what a key declares with what the provider
 * reports. Also the one mapping of a provider's quota refusal to `cap_refused`.
 */
import { BudgetExceededError } from "./budget.ts";
import { InputError, ProviderError } from "./errors.ts";
import type { Billing, CallKind, GenerationProvider, LimitReading } from "./gateway/provider.ts";
import type { ProviderLimit } from "./settings.ts";

/** A paid call refused because its provider's limit is undeclared or contradicted. Exit 3. */
export class ProviderLimitError extends InputError {
  readonly code: "provider_limit_undeclared" | "provider_limit_mismatch";
  readonly provider: string;
  constructor(
    code: "provider_limit_undeclared" | "provider_limit_mismatch",
    provider: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderLimitError";
    this.code = code;
    this.provider = provider;
  }
}

/** The provider refused a call because its own quota or credit ran out: `cap_refused`, exit 3. */
export class ProviderQuotaError extends BudgetExceededError {
  readonly code = "cap_refused";
  readonly status: number;
  readonly providerCode: string | undefined;
  constructor(message: string, status: number, providerCode: string | undefined) {
    super(0, 0, 0, "the call");
    this.name = "ProviderQuotaError";
    this.message = message;
    this.status = status;
    this.providerCode = providerCode;
  }
}

/** Every billing a provider's calls can carry. */
export function billingsOf(provider: GenerationProvider): readonly Billing[] {
  return provider.billings ?? [provider.billing];
}

/** The billing of one kind of call on this provider. */
export function billingFor(provider: GenerationProvider, kind: CallKind): Billing {
  return provider.billingFor?.(kind) ?? provider.billing;
}

/** Whether any call of this provider costs money, as its adapter decided. */
export function isPaid(provider: GenerationProvider | undefined): boolean {
  return provider !== undefined && billingsOf(provider).some((b) => b.paid);
}

/**
 * Throws `provider_limit_undeclared` (exit 3) for a paid billing whose provider has no declared
 * limit, or an `unlimited` one without `acceptUnlimited`. A free billing needs none.
 */
export function assertLimitDeclared(billing: Billing): void {
  if (!billing.paid) return;
  const limit = billing.limit;
  if (limit === undefined) {
    throw new ProviderLimitError(
      "provider_limit_undeclared",
      billing.provider,
      `refused: provider "${billing.provider}" is paid and declares no limit; declare the limit its key carries as providers.${billing.provider}.limit in the developer settings`,
    );
  }
  if (limit.kind === "unlimited" && limit.acceptUnlimited !== true) {
    throw new ProviderLimitError(
      "provider_limit_undeclared",
      billing.provider,
      `refused: provider "${billing.provider}" declares an unlimited key without acceptUnlimited: true`,
    );
  }
}

/** `assertLimitDeclared` for every paid billing of a provider. */
export function assertLimitsDeclared(provider: GenerationProvider | undefined): void {
  if (provider === undefined) return;
  for (const billing of billingsOf(provider)) assertLimitDeclared(billing);
}

/** Spend agreeing within a cent counts as the same amount. */
const CENT = 0.01;

/**
 * Whether a reading contradicts a declared limit: undefined when they cannot be compared. A
 * reported limit must equal the declared `usd`; a prepaid balance may not exceed it.
 */
export function contradicts(limit: ProviderLimit, reading: LimitReading): boolean | undefined {
  if (limit.usd === undefined) return undefined;
  if (reading.limitUsd !== undefined) return Math.abs(reading.limitUsd - limit.usd) > CENT;
  if (limit.kind === "prepaid" && reading.remainingUsd !== undefined)
    return reading.remainingUsd > limit.usd + CENT;
  return undefined;
}

/** One provider's line of `spend check`. */
export interface LimitCheck {
  provider: string;
  adapter: string;
  paid: boolean;
  declared: boolean;
  limit: ProviderLimit | null;
  verified: boolean;
  /** What the provider reported; null when it reports nothing Assetgrove reads. */
  reading: LimitReading | null;
  /** Why the reading failed, when it did. */
  readingError?: string;
  /** True when the reading contradicts the declared limit. */
  mismatch: boolean;
}

/** Declares, reads and compares one provider's limit. Never throws for a failed reading. */
export async function checkLimit(billing: Billing): Promise<LimitCheck> {
  const limit = billing.limit ?? null;
  let reading: LimitReading | null = null;
  let readingError: string | undefined;
  if (billing.limitReading !== undefined) {
    try {
      reading = await billing.limitReading();
    } catch (error) {
      readingError = error instanceof Error ? error.message : String(error);
    }
  }
  const verdict = limit !== null && reading !== null ? contradicts(limit, reading) : undefined;
  return {
    provider: billing.provider,
    adapter: billing.adapter,
    paid: billing.paid,
    declared: limit !== null,
    limit,
    verified: verdict === false,
    reading,
    ...(readingError !== undefined && { readingError }),
    mismatch: verdict === true,
  };
}

/**
 * A provider failure reduced to its message, HTTP status and provider code: never a response
 * body, never a cause. HTTP 402, and HTTP 429 with code `insufficient_quota`, are the provider's
 * quota refusing the call (`ProviderQuotaError`, `cap_refused`).
 */
export function providerFailure(label: string, error: unknown): ProviderError | ProviderQuotaError {
  if (error instanceof ProviderError || error instanceof ProviderQuotaError) return error;
  // The `ai` SDK's RetryError holds the last attempt's error.
  const last = (error as { lastError?: unknown } | null)?.lastError;
  const e = (last ?? error) as Record<string, unknown> | null;
  const message = typeof e?.["message"] === "string" ? e["message"] : String(e);
  const statusValue = e?.["statusCode"] ?? e?.["status"];
  const status = typeof statusValue === "number" ? statusValue : undefined;
  const code = providerCode(e);
  const detail = [
    ...(status !== undefined ? [`HTTP ${status}`] : []),
    ...(code !== undefined ? [code] : []),
  ];
  const text = `${label}: ${message}${detail.length > 0 ? ` (${detail.join(", ")})` : ""}`;
  if (status === 402 || (status === 429 && code === "insufficient_quota"))
    return new ProviderQuotaError(`refused by the provider's quota: ${text}`, status, code);
  return new ProviderError(text);
}

/** The provider's own error code: the error's `code`, its parsed response's, else its `type`. */
function providerCode(e: Record<string, unknown> | null): string | undefined {
  const own = e?.["code"];
  if (typeof own === "string" && !own.startsWith("ERR_")) return own;
  const cause = e?.["cause"] as Record<string, unknown> | undefined;
  const data = (cause?.["data"] ?? e?.["data"]) as Record<string, unknown> | undefined;
  const nested = (data?.["error"] as Record<string, unknown> | undefined)?.["code"];
  if (typeof nested === "string") return nested;
  const type = e?.["type"];
  return typeof type === "string" ? type : undefined;
}
