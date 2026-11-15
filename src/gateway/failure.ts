/**
 * What an adapter copies from a failed provider call into its error: the provider's message, the
 * HTTP status and the provider's error code, never a response body, headers or the request. A
 * quota refusal at the provider (a gateway 402, an OpenAI `insufficient_quota` 429) is a spend
 * refusal, `cap_refused`, not a provider error.
 */
import { BudgetExceededError } from "../budget.ts";
import { ProviderError } from "../errors.ts";
import { redact } from "../redact.ts";

/** The provider refused the call because its key's money ran out. Exit 3 `cap_refused`. */
export class ProviderQuotaError extends BudgetExceededError {
  readonly code = "cap_refused";
  readonly status: number | undefined;
  readonly providerCode: string | undefined;
  constructor(message: string, status?: number, providerCode?: string) {
    super(0, 0, 0, "the call");
    this.name = "ProviderQuotaError";
    this.message = redact(message);
    this.status = status;
    this.providerCode = providerCode;
  }
}

/** The status, provider code and message a provider error carries, read structurally. */
export interface FailureFacts {
  message: string;
  status?: number;
  code?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The facts of a thrown SDK error: message, status (`statusCode`/`status`) and provider code. */
export function failureFacts(error: unknown): FailureFacts {
  if (!isRecord(error) && !(error instanceof Error)) return { message: String(error) };
  const e = error as unknown as Record<string, unknown>;
  const status = [e["statusCode"], e["status"]].find(
    (s): s is number => typeof s === "number" && Number.isInteger(s),
  );
  const data = isRecord(e["data"]) ? e["data"] : undefined;
  const inner = data && isRecord(data["error"]) ? data["error"] : undefined;
  const code = [e["type"], inner?.["code"], inner?.["type"], e["code"]].find(
    (c): c is string => typeof c === "string" && c !== "" && !c.startsWith("ERR_"),
  );
  let message = error instanceof Error ? error.message : String(e["message"] ?? "request failed");
  // A message that repeats the raw response body would carry whatever the body holds.
  const body = e["responseBody"];
  if (typeof body === "string" && body.trim() !== "" && message.includes(body.trim()))
    message = "request failed";
  return { message, ...(status !== undefined && { status }), ...(code !== undefined && { code }) };
}

/**
 * True for a quota refusal: HTTP 402 from the gateway, or HTTP 429 with the provider code
 * `insufficient_quota` (OpenAI's code for a key out of credit or over its project budget).
 */
export function isQuotaRefusal(facts: FailureFacts): boolean {
  return facts.status === 402 || (facts.status === 429 && facts.code === "insufficient_quota");
}

/** The error an adapter throws for a failed call: a quota refusal, or a provider error. */
export function providerFailure(provider: string, label: string, error: unknown): Error {
  if (error instanceof ProviderError || error instanceof BudgetExceededError) return error;
  const facts = failureFacts(error);
  const detail = [
    facts.status !== undefined ? `HTTP ${facts.status}` : undefined,
    facts.code !== undefined ? `code ${facts.code}` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
  const message = `${provider} ${label}: ${facts.message}${detail ? ` (${detail})` : ""}`;
  if (isQuotaRefusal(facts)) {
    return new ProviderQuotaError(
      `refused: ${message}; the provider's own limit for this key is reached`,
      facts.status,
      facts.code,
    );
  }
  return new ProviderError(message);
}
