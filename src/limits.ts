/**
 * Provider limits (design section 3): the provider's own limit is the hard one, so a paid call to
 * a provider whose settings declare none is refused before any spend, and `spend check` reads the
 * provider's balance where it reports one and compares it with what the settings declare.
 */
import type { Billing, DeclaredLimit, LimitReading } from "./gateway/provider.ts";

const EPSILON = 1e-9;

/** A paid call refused for its provider's limit, or a reading that contradicts the declared one. */
export class ProviderLimitError extends Error {
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

/** Whether a limit is declared: any kind, but `unlimited` only with `acceptUnlimited: true`. */
export function isDeclared(limit: DeclaredLimit | undefined): limit is DeclaredLimit {
  if (limit === undefined) return false;
  return limit.kind !== "unlimited" || limit.acceptUnlimited === true;
}

/**
 * Throws `provider_limit_undeclared` (exit 3) when the billing is paid and its provider has no
 * declared limit. A provider without billing counts as paid and undeclared.
 */
export function requireDeclaredLimit(billing: Billing | undefined, what: string): void {
  if (billing !== undefined && !billing.paid) return;
  if (billing !== undefined && isDeclared(billing.limit)) return;
  const provider = billing?.provider ?? "unknown";
  const unlimited = billing?.limit?.kind === "unlimited";
  throw new ProviderLimitError(
    "provider_limit_undeclared",
    provider,
    unlimited
      ? `refused: ${what} is paid and provider "${provider}" declares an unlimited limit without acceptUnlimited: true in the settings file`
      : `refused: ${what} is paid and provider "${provider}" has no declared limit; declare the limit its key carries as providers.${provider}.limit in the settings file`,
  );
}

/** What `spend check` and `settings check` report for one provider. */
export interface LimitCheck {
  provider: string;
  adapter: string;
  paid: boolean;
  declared: boolean;
  limit: DeclaredLimit | null;
  /** True when a reading confirms the declared limit. */
  verified: boolean;
  reading: LimitReading | null;
  /** Why there is no reading, when the provider has a reader that failed. */
  readingError?: string;
  /** True when the reading contradicts the declared limit. */
  mismatch: boolean;
}

/**
 * Compares a reading with the declared limit. Only a `prepaid` limit with `usd` can be verified
 * from a balance: verified when the balance is at most `usd`, a mismatch when it is above (the
 * provider would let more be spent than the settings declare). Other kinds are never verified.
 */
export function compare(
  limit: DeclaredLimit | undefined,
  reading: LimitReading | null,
): { verified: boolean; mismatch: boolean } {
  if (!isDeclared(limit) || reading === null || reading.balanceUsd === undefined)
    return { verified: false, mismatch: false };
  if (limit.kind !== "prepaid" || limit.usd === undefined)
    return { verified: false, mismatch: false };
  const within = reading.balanceUsd <= limit.usd + EPSILON;
  return { verified: within, mismatch: !within };
}

/** Reads one provider's limit, when its adapter can, and compares it with the declared one. */
export async function checkLimit(
  billing: Billing,
  options: { read: boolean },
): Promise<LimitCheck> {
  let reading: LimitReading | null = null;
  let readingError: string | undefined;
  if (options.read && billing.readLimit !== undefined) {
    try {
      reading = await billing.readLimit();
    } catch (error) {
      readingError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    provider: billing.provider,
    adapter: billing.adapter,
    paid: billing.paid,
    declared: isDeclared(billing.limit),
    limit: billing.limit ?? null,
    ...compare(billing.limit, reading),
    reading,
    ...(readingError !== undefined && { readingError }),
  };
}

/** The `provider_limit_mismatch` refusal for the checks whose reading contradicts their limit. */
export function mismatchError(checks: LimitCheck[]): ProviderLimitError | undefined {
  const bad = checks.filter((c) => c.mismatch);
  if (bad.length === 0) return undefined;
  const lines = bad.map(
    (c) =>
      `provider "${c.provider}" declares a ${c.limit?.kind} limit of $${c.limit?.usd?.toFixed(2)} but reads a balance of $${c.reading?.balanceUsd?.toFixed(2)} (${c.reading?.source})`,
  );
  return new ProviderLimitError(
    "provider_limit_mismatch",
    bad[0]!.provider,
    `refused: ${lines.join("; ")}; correct the declared limit in the settings file`,
  );
}
