/**
 * The exit and error-code table (design section 5): every refusal names one error code, and each
 * code maps to one exit. InputError and ProviderError are the typed failures most code throws.
 */
import { redact } from "./redact.ts";

/** Each exit code with what it means. Exit 0 is success and has no error code. */
export const EXIT_MEANING = {
  0: "success",
  1: "internal error",
  2: "invalid input",
  3: "spend refused",
  4: "provider error",
  5: "QA found nothing",
  6: "written output rejected",
  7: "licence refused",
  8: "a person must confirm",
  9: "prompt refused",
} as const;

/** Every error code and its exit. */
export const EXIT = {
  internal_error: 1,
  invalid_input: 2,
  settings_invalid: 2,
  key_tracked: 2,
  format_unsupported: 2,
  extension_unavailable: 2,
  extension_refused: 2,
  extension_conflict: 2,
  route_unavailable: 2,
  plan_changed: 2,
  run_in_progress: 2,
  command_refused: 2,
  cap_refused: 3,
  provider_limit_undeclared: 3,
  provider_limit_mismatch: 3,
  spend_hold: 3,
  provider_error: 4,
  qa_found_nothing: 5,
  validator_rejected: 6,
  handoff_check_failed: 6,
  license_refused: 7,
  confirmation_required: 8,
  confirmation_declined: 8,
  prompt_refused: 9,
} as const satisfies Record<string, Exclude<keyof typeof EXIT_MEANING, 0>>;

export type ErrorCode = keyof typeof EXIT;

/** The caller's input is unusable: a bad spec, file, option or state. Nothing was spent. */
export class InputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InputError";
  }
}

/**
 * A model provider call failed or returned nothing usable. Its message is redacted. An adapter
 * copies only the provider's message, HTTP status and error code into it, never a response body.
 */
export class ProviderError extends Error {
  /** The provider's HTTP status, when it answered with one. */
  readonly status: number | undefined;
  /** The provider's own error code or type, when it reported one. */
  readonly providerCode: string | undefined;
  constructor(
    message: string,
    options?: ErrorOptions & { status?: number | undefined; providerCode?: string | undefined },
  ) {
    super(redact(message), options);
    this.name = "ProviderError";
    this.status = options?.status;
    this.providerCode = options?.providerCode;
  }
}

/**
 * The provider refused a call because the account's own quota or credits are spent: a gateway
 * 402 or an OpenAI 429 `insufficient_quota`. Exit 3 `cap_refused`, like a cap of Assetgrove's own.
 * Not a `ProviderError`, so nothing that tolerates a failed call goes on past it.
 */
export class ProviderQuotaError extends Error {
  readonly code = "cap_refused";
  readonly status: number | undefined;
  readonly providerCode: string | undefined;
  constructor(message: string, options?: { status?: number; providerCode?: string }) {
    super(redact(message));
    this.name = "ProviderQuotaError";
    this.status = options?.status;
    this.providerCode = options?.providerCode;
  }
}

/** The codes that refuse spend (exit 3): a run stops at them rather than going on. */
const SPEND_REFUSALS: ReadonlySet<string> = new Set([
  "cap_refused",
  "provider_limit_undeclared",
  "provider_limit_mismatch",
  "spend_hold",
]);

/** Whether an error carries a spend refusal's code (`cap_refused`, `provider_limit_*`, ...). */
export function isSpendRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && SPEND_REFUSALS.has(code);
}
