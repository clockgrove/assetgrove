import type { Env } from "../env.ts";
import type { ErrorCode } from "../errors.ts";
import type { Confirmation } from "../approvals.ts";
import type { ConfirmPort } from "../confirm/prompt.ts";
import type { ExtensionRegistry } from "../extensions/registry.ts";
import type { Settings } from "../settings.ts";
import type { PromptPolicyRecord } from "../policy/text.ts";
import type { WorkPlan } from "../runs/plan.ts";

export type { PlanJob, WorkPlan } from "../runs/plan.ts";

/** What running a command can do: whether it only reads, whether it spends, and where it writes. */
export interface Effect {
  readOnly: boolean;
  spends: "never" | "always" | "conditional";
  writes: "none" | "runs" | "out" | "target" | "settings" | "state";
}

/** A JSON Schema for one property of a command's input. */
export interface JsonSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description: string;
  items?: { type: "string" };
  /** The value the command uses when the option is absent; shown in help, applied by the command. */
  default?: string | number | boolean;
  minimum?: number;
  /** How help shows the value, for example `<spec.json>`; defaults to `<name>`. */
  placeholder?: string;
  /** True when only the CLI takes the option: the command's tool leaves it out of its schema. */
  cliOnly?: true;
}

/** A command's input: an object schema whose properties are its options and positionals. */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties: false;
}

/** What a run of a command is given besides its arguments. */
export interface RunContext {
  /** The developer settings, loaded for each CLI command and MCP tool call (src/commands/context.ts). */
  settings: Settings;
  /**
   * Core and the extensions the settings list, loaded with the settings (src/extensions/registry.ts);
   * core alone when absent.
   */
  extensions?: ExtensionRegistry;
  /** Receives log lines; the CLI sends them to stderr. */
  log: (message: string) => void;
  /** The environment the refusal rule reads; the process environment when absent. */
  env?: Env;
  /** The MCP server's --provider-script, given to each tool call of a command that takes one. */
  providerScript?: string;
  /** The MCP server's --work-item, given to each tool call that names no work item. */
  workItem?: string;
  /** A channel to ask a person (the CLI's inline TTY prompt); absent when no one can be asked. */
  prompt?: ConfirmPort;
  /**
   * The run of a paid command's real run: its directory `<runs>/r-<16 hex>/`, where the runner has
   * written `request.json`, and the WorkPlan its plan step returned. `promptPolicy` is the record
   * after the run's prompt-policy check (with `fallback` when the command must use its template's
   * prompt in place of the compiler's).
   */
  run?: { dir: string; plan: WorkPlan; promptPolicy?: PromptPolicyRecord };
  /**
   * Where a paid run reports its progress while a client is connected (the MCP server's
   * `notifications/progress` for a request that carries a progressToken).
   */
  progress?: (update: { progress: number; total: number; message: string }) => void;
}

/** A refusal's code and message; a spend-limit refusal also names the limit and its numbers. */
export interface Failure {
  code: ErrorCode;
  message: string;
  /** For `format_unsupported`: why the format line was refused (`missing`, `too_new`, `unknown`). */
  reason?: string;
  /** For exit 8: what a person must confirm, and how (design section 7). */
  confirmation?: Confirmation;
  /** For `handoff_check_failed` (preset, problem) and `library_check_failed` (file, code): each problem a hand-off preset's check found (design section 14). */
  problems?: Array<{ preset?: string; problem?: string; file?: string; code?: string }>;
  /** For `prompt_refused`: the policy check that refused the prompt. */
  policy?: PromptPolicyRecord;
  limit?: {
    name: string;
    workItem?: string;
    limitUsd: number;
    spentUsd: number;
    requestedUsd: number;
    ledger: string;
  };
}

/** What a command produced: the JSON fields, the human summary and an optional refusal. */
export interface Outcome {
  exitCode: number;
  fields: Record<string, unknown>;
  human: string;
  error?: Failure;
  /** The command that answered, when not the one that ran: estimate answers as the paid command. */
  command?: string;
}

/** One command, declared once: its input schema and effect, and how it runs. */
export interface CommandSpec<A = Record<string, unknown>> {
  name: string;
  /** The MCP tool that serves this command, or null when no tool does. */
  tool: string | null;
  summary: string;
  details: string;
  input: JsonSchemaObject;
  positionals?: { name: string; variadic?: boolean }[];
  effect: Effect;
  confirm?: "spend" | "pick" | "write" | "settings";
  /**
   * The extension slot the command needs (design section 7.1): while it is empty, help and the
   * tool list leave the command out and a call exits 2 `extension_unavailable`.
   */
  requires?: "search";
  /** False when the command prints no JSON document (it takes no --json). Defaults to true. */
  json?: false;
  /** The free plan step of a paid command: no provider call, no ledger entry (design section 6). */
  plan?(args: A, ctx: RunContext): Promise<WorkPlan>;
  /**
   * An earlier request's confirmation that covers this one (design section 7: apply uses its
   * plan's record while every input hash matches and its forecast is at or under the confirmed
   * one); undefined when none does, and this request asks under its own digest.
   */
  priorConfirmation?(
    args: A,
    ctx: RunContext,
    plan: WorkPlan,
  ): Promise<import("../types.ts").ConfirmationRecord | undefined>;
  run(args: A, ctx: RunContext): Promise<Outcome>;
}

/**
 * Declares a command with its typed arguments; the registry holds every command at one type. The
 * runner validates the arguments against `input` before `run` sees them.
 */
export function defineCommand<A>(spec: CommandSpec<A>): CommandSpec {
  return spec as unknown as CommandSpec;
}
