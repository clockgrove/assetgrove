/**
 * Confirmation through an MCP client's form (design section 7). A tool call whose client declares
 * form elicitation gets a port that answers the one request the call's sealed `requestState` names,
 * from the person's response to the form. Any other request it is asked is recorded and exits 8 as
 * before; the server then returns that request as `inputRequired` with its form and a new sealed
 * state, and the client calls the tool again. On re-entry the command recomputes its request: one of
 * the sealed kind under another digest exits 2 `plan_changed`. Accepting writes the same record the
 * terminal writes, with method `elicitation`, the client's name and protocol version.
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import type { ClientCapabilities, ElicitRequestFormParams } from "@modelcontextprotocol/server";
import { ConfirmationError } from "../approvals.ts";
import { PlanChangedError } from "../planning.ts";
import { describeRequest } from "./prompt.ts";
import type { ChannelFields, ConfirmKind, ConfirmPort, ConfirmRequest } from "./prompt.ts";

/** What a tool call's `requestState` seals: the call, and the request its form asks. */
export interface SealedRequest {
  /** The tool called. */
  tool: string;
  /** The sha256 of the call's canonical arguments. */
  args: string;
  kind: ConfirmKind;
  /** The request's digest, or a command's hash. */
  id: string;
}

/** The person's response to a form. */
export interface FormAnswer {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

/** The client of a tool call, as the record names it. */
export interface McpClient {
  /** True when the client declares form elicitation. */
  form: boolean;
  name?: string;
  protocolVersion?: string;
}

/** An MCP port: it also reports the first request it could not answer. */
export interface ElicitationPort extends ConfirmPort {
  method: "elicitation";
  /** The request to ask the person in a form, once a call reached one no answer covers. */
  asked(): ConfirmRequest | undefined;
}

/**
 * Whether capabilities declare form elicitation: `elicitation.form`, or an `elicitation` that names
 * neither mode (the form mode, for clients that predate modes).
 */
export function declaresForm(capabilities: ClientCapabilities | undefined): boolean {
  const elicitation = capabilities?.elicitation as Record<string, unknown> | undefined;
  if (elicitation === undefined || elicitation === null) return false;
  return "form" in elicitation || !("url" in elicitation);
}

/**
 * The client of a request: the per-request envelope on 2026-07-28 requests, else what the
 * connection's `initialize` declared.
 */
export function clientOf(
  envelope: Record<string, unknown> | undefined,
  connection: {
    capabilities?: ClientCapabilities;
    name?: string;
    protocolVersion?: string;
  },
): McpClient {
  const info = envelope?.[CLIENT_INFO_META_KEY] as { name?: unknown } | undefined;
  const version = envelope?.[PROTOCOL_VERSION_META_KEY];
  const capabilities =
    envelope !== undefined && CLIENT_CAPABILITIES_META_KEY in envelope
      ? (envelope[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities)
      : connection.capabilities;
  const name = typeof info?.name === "string" ? info.name : connection.name;
  const protocolVersion = typeof version === "string" ? version : connection.protocolVersion;
  return {
    form: declaresForm(capabilities),
    ...(name !== undefined && { name }),
    ...(protocolVersion !== undefined && { protocolVersion }),
  };
}

/** The candidates a pick form offers: the named one, or every passing one; and `none`. */
function pickChoices(request: ConfirmRequest): string[] {
  const named = request.body?.["candidate"];
  return [...(typeof named === "string" ? [named] : (request.choices ?? [])), "none"];
}

/**
 * The flat form of a request. The message shows the request's fields, one per line. A pick asks
 * `{candidate: enum(ids + "none"), note?}`; spend, write and command ask a Boolean `approve`.
 */
export function confirmForm(request: ConfirmRequest): ElicitRequestFormParams {
  const message = describeRequest(request);
  if (request.kind === "pick") {
    return {
      mode: "form",
      message,
      requestedSchema: {
        type: "object",
        properties: {
          candidate: {
            type: "string",
            title: "Candidate",
            description: "the candidate to pick; none declines",
            enum: pickChoices(request),
          },
          note: { type: "string", title: "Note", description: "a note kept with the pick" },
        },
        required: ["candidate"],
      },
    };
  }
  return {
    mode: "form",
    message,
    requestedSchema: {
      type: "object",
      properties: {
        approve: {
          type: "boolean",
          title: "Approve",
          description: `approve this ${request.kind} request`,
        },
      },
      required: ["approve"],
    },
  };
}

/**
 * The port of one tool call. `sealed` and `answer` are the request this call's state names and the
 * person's response to its form; `fields` what the record says of the client and the tool.
 */
export function elicitationPort(options: {
  sealed?: SealedRequest;
  answer?: FormAnswer;
  fields: Omit<ChannelFields, "note">;
}): ElicitationPort {
  let pending = options.sealed;
  let asked: ConfirmRequest | undefined;
  let note: string | undefined;
  const answerFor = (request: ConfirmRequest): FormAnswer => {
    if (pending !== undefined && pending.kind === request.kind) {
      if (pending.id !== request.id) {
        throw new PlanChangedError(
          `the ${request.kind} request changed while the person answered its form (was ${pending.id}, now ${request.id}); call the tool again`,
        );
      }
      pending = undefined;
      if (options.answer !== undefined) {
        const content = options.answer.content;
        if (request.kind === "pick" && typeof content?.["note"] === "string" && content["note"])
          note = content["note"];
        return options.answer;
      }
    }
    asked ??= request;
    throw new ConfirmationError(
      "confirmation_required",
      `${request.summary} needs a person's confirmation`,
    );
  };
  return {
    method: "elicitation",
    asked: () => asked,
    async confirm(request) {
      const answer = answerFor(request);
      if (answer.action !== "accept") return false;
      if (request.kind === "pick")
        return answer.content?.["candidate"] === request.body?.["candidate"];
      return answer.content?.["approve"] === true;
    },
    async choose(request) {
      const answer = answerFor(request);
      const candidate = answer.content?.["candidate"];
      if (answer.action !== "accept" || typeof candidate !== "string") return undefined;
      return candidate === "none" || (request.choices ?? []).includes(candidate)
        ? candidate
        : undefined;
    },
    recordFields: () => ({ ...options.fields, ...(note !== undefined && { note }) }),
  };
}
