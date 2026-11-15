/**
 * Spend, pick and write confirmation (design section 7). Sources, in order: headless settings
 * (method `headless`; a headless pick must name its candidate); the record at
 * `<configDir>/confirmations/<hex>.json` for the request's digest; a prior confirmation the
 * command names (apply's plan); an MCP client's form (method `elicitation`, src/confirm/mcp.ts) or
 * the inline prompt of a TTY (method `tty`); otherwise the request
 * is saved to `<stateDir>/pending/<id>.json` and exit 8 `confirmation_required` carries it, and
 * `assetgrove confirm <id>` completes it (method `terminal`). Every method writes the record.
 */
import { ConfirmationError } from "../approvals.ts";
import { InputError } from "../errors.ts";
import type { Settings } from "../settings.ts";
import type { ConfirmationMethod, ConfirmationRecord } from "../types.ts";
import { savePending } from "./pending.ts";
import type { ChannelFields, ConfirmPort, ConfirmRequest } from "./prompt.ts";
import { digestOf, readConfirmation, writeConfirmation } from "./records.ts";

export { confirmationPath, digestOf, readConfirmation, writeConfirmation } from "./records.ts";
export type { ConfirmationMethod, ConfirmationRecord } from "../types.ts";

/** The kinds this module confirms. */
export type RequestKind = ConfirmationRecord["kind"];

/** A spend, pick or write request: its body hashes to its id. */
export interface KindRequest extends ConfirmRequest {
  kind: RequestKind;
  body: Record<string, unknown>;
  /** A write's grouping, whose digest its body holds, so `confirm` can check the families shown. */
  grouping?: unknown;
}

/** The `error.confirmation` of a spend, pick or write no one confirmed. */
export interface RequestConfirmation {
  kind: RequestKind;
  id: string;
  summary: string;
  confirmCommand: string;
}

/** What confirming reads: the settings, and a channel to ask a person when there is one. */
export interface ConfirmGate {
  settings: Pick<Settings, "configDir" | "stateDir" | "mode" | "headless">;
  prompt?: ConfirmPort;
}

/** The record of a request confirmed by `method`, with the pick's choice when it has one. */
export function recordOf(
  request: KindRequest,
  method: ConfirmationMethod,
  extra: {
    choice?: string;
    operator?: string;
    channel?: ChannelFields;
  } = {},
): ConfirmationRecord {
  const { body } = request;
  const number = (value: unknown) => (typeof value === "number" ? value : 0);
  const inputs =
    typeof body["inputs"] === "object" && body["inputs"] !== null
      ? (body["inputs"] as Record<string, string>)
      : {};
  const choice =
    extra.choice ?? (typeof body["candidate"] === "string" ? body["candidate"] : undefined);
  return {
    kind: request.kind,
    digest: request.id,
    method,
    at: new Date().toISOString(),
    forecastUsd: number(body["forecastUsd"]),
    capUsd: number(body["capUsd"]),
    inputs: { ...inputs },
    ...(choice !== undefined && { choice }),
    ...(extra.channel?.note !== undefined && { note: extra.channel.note }),
    ...(extra.channel?.client !== undefined && { client: extra.channel.client }),
    ...(extra.channel?.protocolVersion !== undefined && {
      protocolVersion: extra.channel.protocolVersion,
    }),
    toolMarkedRequiresUser: extra.channel?.toolMarkedRequiresUser ?? false,
    ...(extra.operator !== undefined && { operator: extra.operator }),
    selfReported: true,
  };
}

/** True when a pending request's body hashes to its id. */
export function verifiedRequest(request: ConfirmRequest): request is KindRequest {
  return (
    (request.kind === "spend" || request.kind === "pick" || request.kind === "write") &&
    typeof request.body === "object" &&
    request.body !== null &&
    digestOf(request.body) === request.id
  );
}

function asked(request: KindRequest): RequestConfirmation {
  return {
    kind: request.kind,
    id: request.id,
    summary: request.summary,
    confirmCommand: `assetgrove confirm ${request.id}`,
  };
}

/** Exit 8 `confirmation_declined` for a request a person declined. */
export function declined(request: KindRequest): ConfirmationError {
  return new ConfirmationError(
    "confirmation_declined",
    `the ${request.kind} confirmation ${request.id} was declined`,
    asked(request),
  );
}

/**
 * The confirmation of a request, from the first source that has one (see the module comment).
 * `prior` names a confirmation an earlier request gave that covers this one (apply's plan).
 * Throws exit 8 when no one confirmed, exit 2 for a headless pick that names no candidate.
 */
export async function requireConfirmation(
  request: KindRequest,
  gate: ConfirmGate,
  options: { prior?: () => Promise<ConfirmationRecord | undefined> } = {},
): Promise<ConfirmationRecord> {
  const { settings, prompt } = gate;
  const named = typeof request.body["candidate"] === "string";
  if (settings.mode === "headless") {
    if (request.kind === "pick" && !named)
      throw new InputError(
        "a headless pick must name its candidate: pass --candidate <id> (headless settings choose nothing)",
      );
    const record = recordOf(request, "headless", {
      ...(settings.headless && { operator: settings.headless.operator }),
    });
    await writeConfirmation(settings.configDir, record);
    return record;
  }
  const stored = await readConfirmation(settings.configDir, request.kind, request.id);
  if (stored !== undefined) return stored;
  const prior = await options.prior?.();
  if (prior !== undefined) return prior;
  if (prompt && (named || request.kind !== "pick" || prompt.choose)) {
    let choice: string | undefined;
    if (request.kind === "pick" && !named) {
      choice = await prompt.choose!(request);
      if (choice === undefined || choice === "none") throw declined(request);
    } else if (!(await prompt.confirm(request))) throw declined(request);
    const channel = prompt.recordFields?.(request);
    const record = recordOf(request, prompt.method, {
      ...(choice !== undefined && { choice }),
      ...(channel && { channel }),
    });
    await writeConfirmation(settings.configDir, record);
    return record;
  }
  await savePending(settings.stateDir, request);
  throw new ConfirmationError(
    "confirmation_required",
    `${request.summary} needs a person's confirmation; run: assetgrove confirm ${request.id}`,
    asked(request),
  );
}
