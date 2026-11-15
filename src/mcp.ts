import {
  McpServer,
  createRequestStateCodec,
  fromJsonSchema,
  inputRequired,
  inputResponse,
  isInputRequiredResult,
} from "@modelcontextprotocol/server";
import type {
  RequestStateCodec,
  ServerContext,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { randomBytes } from "node:crypto";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { join, resolve } from "node:path";
import { describeBible, useBiblePreset } from "./bible.ts";
import {
  checkContextEnvironment,
  createRunContext,
  isPaid,
  settingsScope,
} from "./commands/context.ts";
import { commands } from "./commands/registry.ts";
import { resultDocument } from "./commands/result.ts";
import { errorOutcome, runCommand, toolInputSchema } from "./commands/runner.ts";
import type { CommandSpec, Outcome, RunContext } from "./commands/types.ts";
import { clientOf, confirmForm, elicitationPort } from "./confirm/mcp.ts";
import type { FormAnswer, SealedRequest } from "./confirm/mcp.ts";
import { digestOf } from "./confirm/records.ts";
import { InputError, ProviderError } from "./errors.ts";
import { checkTrackedKeys } from "./guard.ts";
import { redact } from "./redact.ts";
import type { GenerationProvider } from "./gateway/provider.ts";
import { PlanChangedError, applyPlan, createPlan, savePlan } from "./planning.ts";
import type { SpendLedger } from "./spend.ts";
import { projectDir } from "./tree/project.ts";
import { TreeServer } from "./tree/serve.ts";

export interface ToolContext {
  provider?: GenerationProvider;
  providerName?: string;
  /** The cross-run spend ledger every paid call also reserves against (src/spend.ts). */
  ledger?: SpendLedger;
  /** Receives one line per provider decision call during apply. */
  log?: (message: string) => void;
  /** The developer settings' run cap (`caps.runUsd`), which bounds plan and apply. */
  runCapUsd?: number;
  /** The developer settings' prompt-policy allow terms (`promptPolicy.allow`). */
  promptAllow?: readonly string[];
  /** The plan command's request digest, recorded in the saved plan. */
  requestDigest?: string;
}

type Arguments = Record<string, unknown>;

function stringArg(args: Arguments, key: string, required = true): string | undefined {
  const value = args[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim() === "")
    throw new InputError(`missing or invalid ${key}`);
  return value;
}

/** CLI and MCP share the same file loading and generation entry points. */
export function generationTool(
  name: "apply",
  args: Arguments,
  context?: ToolContext,
): ReturnType<typeof applyPlan>;
export function generationTool(
  name: string,
  args: Arguments,
  context?: ToolContext,
): Promise<Record<string, unknown>>;
export async function generationTool(
  name: string,
  args: Arguments,
  context: ToolContext = {},
): Promise<Record<string, unknown>> {
  if (name === "bible_describe") return describeBible(stringArg(args, "bible")!);
  if (name === "bible_preset") {
    return useBiblePreset({
      biblePath: stringArg(args, "bible")!,
      preset: stringArg(args, "preset")!,
    });
  }
  if (name === "plan") {
    const optional = (key: string) => stringArg(args, key, false);
    const created = await createPlan({
      biblePath: stringArg(args, "bible")!,
      specPath: stringArg(args, "spec")!,
      profilePath: stringArg(args, "profile")!,
      ...(optional("brief") && { briefPath: optional("brief")! }),
      ...(optional("runOptions") && { runOptionsPath: optional("runOptions")! }),
      ...(optional("template") && { templatePath: optional("template")! }),
      ...(optional("identityMode") && { identityMode: optional("identityMode")! }),
      ...context,
    });
    const planPath = resolve(stringArg(args, "out")!);
    await savePlan(created.plan, planPath);
    return { planPath, ...created };
  }
  if (name === "apply") {
    if (!context.provider) throw new ProviderError("apply requires a generation provider");
    const result = await applyPlan(stringArg(args, "plan")!, {
      provider: context.provider,
      providerName: context.providerName,
      ...(context.ledger && { ledger: context.ledger }),
      ...(context.log && { log: context.log }),
      ...(context.runCapUsd !== undefined && { runCapUsd: context.runCapUsd }),
      ...(context.promptAllow && { promptAllow: context.promptAllow }),
      ...(stringArg(args, "out", false) && { outDir: args["out"] as string }),
    });
    return result;
  }
  throw new InputError(`unknown generation tool ${name}`);
}

/** The one output schema of every tool: the result document, open to each command's fields. */
const outputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    exitCode: { type: "integer" },
    command: { type: ["string", "null"] },
    error: {
      type: "object",
      properties: { code: { type: "string" }, message: { type: "string" } },
      required: ["code", "message"],
    },
  },
  required: ["ok", "exitCode", "command"],
};

/** The confirmation kinds headless settings answer without a person. */
const HEADLESS_ANSWERS: ReadonlySet<string> = new Set(["spend", "pick", "write"]);

/**
 * Whether a tool is marked as requiring the person (`anthropic/requiresUserInteraction`): every
 * tool with a confirmation, except spend, pick and write tools when the settings are headless.
 */
export function requiresUserInteraction(spec: CommandSpec, headless: boolean): boolean {
  if (spec.confirm === undefined) return false;
  return !(headless && HEADLESS_ANSWERS.has(spec.confirm));
}

/** A tool's annotations, from its command's effect (design section 5). */
export function toolAnnotations(spec: CommandSpec): ToolAnnotations {
  const paid = isPaid(spec);
  return {
    readOnlyHint: spec.effect.readOnly,
    destructiveHint: spec.tool === "pick" || spec.tool === "write_families",
    idempotentHint: paid,
    openWorldHint: paid,
  };
}

/** A tool call's arguments with the server's scripted provider and work item filled in. */
function commandArgs(spec: CommandSpec, args: Arguments, ctx: RunContext): Arguments {
  const properties = spec.input.properties;
  return {
    ...(ctx.providerScript !== undefined &&
      "providerScript" in properties && { providerScript: ctx.providerScript }),
    ...(ctx.workItem !== undefined && "workItem" in properties && { workItem: ctx.workItem }),
    ...args,
  };
}

/**
 * The context of one tool call: a request that carries a progressToken gets the run's progress
 * as `notifications/progress` while its client is connected. A notification the client can no
 * longer receive is dropped; the run goes on (design section 9).
 */
function withProgress(ctx: RunContext, request: ServerContext): RunContext {
  const progressToken = request.mcpReq._meta?.progressToken;
  if (progressToken === undefined) return ctx;
  return {
    ...ctx,
    progress: (update) => {
      try {
        request.mcpReq
          .notify({ method: "notifications/progress", params: { progressToken, ...update } })
          .catch(() => {});
      } catch {
        // The client is gone; the run goes on without it.
      }
    },
  };
}

function packageInfo(): { name: string; version: string } {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    name: string;
    version: string;
  };
}

/** The contact sheet a result names (`runDir` and `contactSheet`) as MCP image content. */
async function contactImage(
  document: Record<string, unknown>,
): Promise<Array<{ type: "image"; data: string; mimeType: string }>> {
  const { runDir, contactSheet } = document;
  if (typeof runDir !== "string" || typeof contactSheet !== "string") return [];
  try {
    const bytes = await readFile(join(runDir, contactSheet));
    return [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }];
  } catch {
    return [];
  }
}

/**
 * How long a confirmation form stays answerable: a person who walks away and comes back the next
 * day still finds it. A request that changed meanwhile is refused on re-entry by its digest.
 */
export const FORM_TTL_SECONDS = 24 * 60 * 60;

/** The codec that seals each confirmation form's state for `FORM_TTL_SECONDS`, under `key`. */
export function formStateCodec(
  key: Uint8Array = randomBytes(32),
): RequestStateCodec<SealedRequest> {
  return createRequestStateCodec<SealedRequest>({ key, ttlSeconds: FORM_TTL_SECONDS });
}

/**
 * The context of one tool call: the server's log, environment, provider script and work item, with
 * the developer settings loaded now (src/commands/context.ts), so a change written by
 * settings_change or by hand holds from the next call. The settings file is checked against the
 * call's target and input files too.
 */
async function callContext(server: RunContext, args: Arguments): Promise<RunContext> {
  return createRunContext({
    log: server.log,
    ...(server.env && { env: server.env }),
    ...(server.providerScript !== undefined && { providerScript: server.providerScript }),
    ...(server.workItem !== undefined && { workItem: server.workItem }),
    ...settingsScope(args),
  });
}

/** `ls` and `cat` read the tree the server serves unless the call names another project. */
function browseArgs(spec: CommandSpec, args: Arguments, tree: TreeServer): Arguments {
  if ((spec.tool !== "ls" && spec.tool !== "cat") || args["target"] !== undefined) return args;
  return { ...args, target: tree.dir };
}

/** The context with each progress update also checking the tree for changes the call made. */
function withTreeProgress(ctx: RunContext, check: () => void): RunContext {
  const report = ctx.progress;
  return {
    ...ctx,
    progress: (update) => {
      report?.(update);
      check();
    },
  };
}

/** The key of the inputRequired form a confirmation is asked under. */
const FORM_KEY = "confirm";

/** The person's response to the form a call's sealed state asked, when the client sent one. */
function formAnswer(request: ServerContext): FormAnswer | undefined {
  const view = inputResponse(request.mcpReq.inputResponses, FORM_KEY);
  if (view.kind !== "elicit") return undefined;
  return { action: view.action, ...(view.content && { content: view.content }) };
}

/**
 * Runs one tool call. A client that declares form elicitation gets a port answering the request
 * its sealed state names (src/confirm/mcp.ts); when the command reaches a request no answer covers,
 * the call returns inputRequired with that request's form and a sealed state naming it, and the
 * client calls again with the person's response. A call whose arguments differ from the ones its
 * state sealed exits 2 `plan_changed`.
 */
async function callTool(
  spec: CommandSpec,
  args: Arguments,
  ctx: RunContext,
  request: ServerContext,
  server: McpServer,
  codec: RequestStateCodec<SealedRequest>,
  marked: boolean,
  progress: () => void = () => {},
): Promise<Outcome | ReturnType<typeof inputRequired>> {
  const tool = spec.tool!;
  const argsDigest = digestOf(args);
  const sealed = request.mcpReq.requestState<SealedRequest>();
  if (sealed !== undefined && (sealed.tool !== tool || sealed.args !== argsDigest)) {
    return errorOutcome(
      new PlanChangedError(`the ${tool} call changed since its confirmation form was sent`),
    );
  }
  const client = clientOf(request.mcpReq.envelope as Record<string, unknown> | undefined, {
    capabilities: server.server.getClientCapabilities(),
    name: server.server.getClientVersion()?.name,
    protocolVersion: server.server.getNegotiatedProtocolVersion(),
  });
  const answer = formAnswer(request);
  const port = client.form
    ? elicitationPort({
        ...(sealed && { sealed }),
        ...(answer && { answer }),
        fields: {
          ...(client.name !== undefined && { client: client.name }),
          ...(client.protocolVersion !== undefined && { protocolVersion: client.protocolVersion }),
          toolMarkedRequiresUser: marked,
        },
      })
    : undefined;
  const full = commandArgs(spec, args, ctx);
  let fresh: RunContext;
  try {
    fresh = await callContext(ctx, full);
  } catch (error) {
    return errorOutcome(error);
  }
  // The server's process has no terminal to ask: the form is the only channel.
  const callCtx: RunContext = withTreeProgress(withProgress(fresh, request), progress);
  delete callCtx.prompt;
  if (port) callCtx.prompt = port;
  const outcome = await runCommand(spec, full, callCtx);
  const asked = port?.asked();
  if (asked === undefined || outcome.error?.code !== "confirmation_required") return outcome;
  return inputRequired({
    inputRequests: { [FORM_KEY]: inputRequired.elicit(confirmForm(asked)) },
    requestState: await codec.mint({ tool, args: argsDigest, kind: asked.kind, id: asked.id }),
  });
}

/**
 * One MCP server instance with a tool per registry command that names one. Each tool runs its
 * command as the CLI does and returns the CLI's --json document as structuredContent and as text.
 * `codec` seals each confirmation form's state; one codec serves every round of a process. The
 * project's asset tree is served as resources (src/tree/serve.ts), and each tool call is checked
 * for the changes it made to it.
 */
function createServer(
  ctx: RunContext,
  codec: RequestStateCodec<SealedRequest>,
  tree: TreeServer,
  era: "legacy" | "modern",
): McpServer {
  const { name, version } = packageInfo();
  const headless = ctx.settings.mode === "headless";
  // The tool list is fixed; the resource list follows the library.
  const server = new McpServer(
    { name, version },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: true, listChanged: true },
      },
      requestState: { verify: codec.verify },
      // A 2025-era client's form waits as long as a sealed state stays answerable.
      inputRequired: { roundTimeoutMs: FORM_TTL_SECONDS * 1000 },
    },
  );
  for (const spec of commands) {
    if (spec.tool === null) continue;
    const input = fromJsonSchema<Arguments>(toolInputSchema(spec));
    // tools/list shows the schema; the handler checks it, so a refusal is a result document too.
    const listed = {
      "~standard": { ...input["~standard"], validate: (value: unknown) => ({ value }) },
    };
    const marked = requiresUserInteraction(spec, headless);
    server.registerTool(
      spec.tool,
      {
        description: `${spec.summary[0]!.toUpperCase()}${spec.summary.slice(1)}.`,
        inputSchema: listed as typeof input,
        outputSchema: fromJsonSchema<Arguments>(outputSchema),
        annotations: toolAnnotations(spec),
        ...(marked && { _meta: { "anthropic/requiresUserInteraction": true } }),
      },
      async (args, request) => {
        const checked = await input["~standard"].validate(args ?? {});
        const outcome = checked.issues
          ? errorOutcome(
              new InputError(
                `invalid ${spec.tool} input: ${checked.issues.map((i) => i.message).join("; ")}`,
              ),
            )
          : await tree.around(
              spec.tool!,
              (progress) =>
                callTool(
                  spec,
                  browseArgs(spec, args ?? {}, tree),
                  ctx,
                  request,
                  server,
                  codec,
                  marked,
                  progress,
                ),
              (result) => !isInputRequiredResult(result) && result.exitCode === 0,
            );
        if (isInputRequiredResult(outcome)) return outcome;
        const document = resultDocument(spec.name, outcome);
        // The run's contact sheet goes with the result as image content (design section 10).
        const sheet = await contactImage(document);
        return {
          content: [{ type: "text", text: JSON.stringify(document) }, ...sheet],
          structuredContent: document,
          isError: document["ok"] !== true,
        };
      },
    );
  }
  tree.attach(server, era);
  return server;
}

/**
 * Serves the tools, and the asset tree of the project at `target` (else the working directory's
 * Git top level) as resources, over MCP stdio with the official SDK until the input closes; no
 * logs on stdout. Refuses (exit 2 `settings_invalid`) to start in an environment the settings disallow,
 * and (exit 2 `key_tracked`) when a tracked file of the working directory's repository holds a key.
 */
export async function serveMcp(
  ctx: RunContext,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  options: { target?: string } = {},
): Promise<void> {
  checkContextEnvironment(ctx);
  checkTrackedKeys(process.cwd(), { settings: ctx.settings, ...(ctx.env && { env: ctx.env }) });
  const ended = new Promise<void>((done) => {
    input.once("end", done);
    input.once("close", done);
  });
  // A per-process key: stdio serves every round of a confirmation form in this one process.
  const codec = formStateCodec();
  const dir = projectDir(options.target);
  const handle = serveStdio(
    ({ era }) => createServer(ctx, codec, new TreeServer(dir, ctx.settings.stateDir), era),
    {
      transport: new StdioServerTransport(input, output),
      onerror: (error) => ctx.log(redact(`mcp: ${error.message}`)),
    },
  );
  await ended;
  await handle.close();
}
