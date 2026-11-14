import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { readFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { resolve } from "node:path";
import { describeBible, initBible, useBiblePreset } from "./bible.ts";
import { checkContextEnvironment, isPaid } from "./commands/context.ts";
import { commands } from "./commands/registry.ts";
import { resultDocument } from "./commands/result.ts";
import { errorOutcome, runCommand, toolInputSchema } from "./commands/runner.ts";
import type { CommandSpec, RunContext } from "./commands/types.ts";
import { InputError, ProviderError } from "./errors.ts";
import { checkTrackedKeys } from "./guard.ts";
import { redact } from "./redact.ts";
import type { GenerationProvider } from "./gateway/provider.ts";
import { loadProfile, readJson } from "./inputs.ts";
import { applyPlan, createPlan, savePlan } from "./planning.ts";
import type { GenerationBrief, RunSettings } from "./planning.ts";
import { loadRoutes } from "./routes.ts";
import type { SpendLedger } from "./spend.ts";
import type { AssetSpec } from "./types.ts";

export interface ToolContext {
  provider?: GenerationProvider;
  providerName?: string;
  /** The cross-run spend ledger every paid call also reserves against (src/spend.ts). */
  ledger?: SpendLedger;
  /** The settings' run cap; a plan's own cap never exceeds it. */
  capCeilingUsd?: number;
  /** Receives one line per provider decision call during apply. */
  log?: (message: string) => void;
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
  if (name === "bible_init") {
    return initBible({
      directory: stringArg(args, "directory")!,
      world: stringArg(args, "world")!,
      preset: stringArg(args, "preset")! as Parameters<typeof initBible>[0]["preset"],
    });
  }
  if (name === "plan") {
    const spec = await readJson<AssetSpec>(stringArg(args, "spec")!);
    const profile = await loadProfile(stringArg(args, "profile")!);
    const briefPath = stringArg(args, "brief", false);
    const settingsPath = stringArg(args, "settings", false);
    const plan = await createPlan({
      biblePath: stringArg(args, "bible")!,
      spec: spec.value,
      specDir: spec.dir,
      profile: profile.value,
      ...(briefPath && { brief: (await readJson<GenerationBrief>(briefPath)).value }),
      ...(settingsPath && { settings: (await readJson<Partial<RunSettings>>(settingsPath)).value }),
      ...(stringArg(args, "template", false) && { templatePath: args["template"] as string }),
      routes: await loadRoutes(stringArg(args, "routes", false)),
      ...(stringArg(args, "identityMode", false) && {
        identityMode: args["identityMode"] as string,
      }),
      ...context,
    });
    const planPath = resolve(stringArg(args, "out")!);
    await savePlan(plan, planPath);
    return { planPath, plan };
  }
  if (name === "apply") {
    if (args["autoApprove"] !== undefined && typeof args["autoApprove"] !== "boolean")
      throw new InputError("autoApprove must be a boolean");
    if (!context.provider) throw new ProviderError("apply requires a generation provider");
    const result = await applyPlan(stringArg(args, "plan")!, {
      provider: context.provider,
      providerName: context.providerName,
      ...(context.ledger && { ledger: context.ledger }),
      ...(context.capCeilingUsd !== undefined && { capCeilingUsd: context.capCeilingUsd }),
      ...(context.log && { log: context.log }),
      autoApprove: args["autoApprove"] === true,
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

function packageInfo(): { name: string; version: string } {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    name: string;
    version: string;
  };
}

/**
 * One MCP server instance with a tool per registry command that names one. Each tool runs its
 * command as the CLI does and returns the CLI's --json document as structuredContent and as text.
 */
function createServer(ctx: RunContext): McpServer {
  const { name, version } = packageInfo();
  const headless = ctx.settings.mode === "headless";
  // The tool list is fixed, so the server never sends list-changed notifications.
  const server = new McpServer(
    { name, version },
    { capabilities: { tools: { listChanged: false } } },
  );
  for (const spec of commands) {
    if (spec.tool === null) continue;
    const input = fromJsonSchema<Arguments>(toolInputSchema(spec));
    // tools/list shows the schema; the handler checks it, so a refusal is a result document too.
    const listed = {
      "~standard": { ...input["~standard"], validate: (value: unknown) => ({ value }) },
    };
    server.registerTool(
      spec.tool,
      {
        description: `${spec.summary[0]!.toUpperCase()}${spec.summary.slice(1)}.`,
        inputSchema: listed as typeof input,
        outputSchema: fromJsonSchema<Arguments>(outputSchema),
        annotations: toolAnnotations(spec),
        ...(requiresUserInteraction(spec, headless) && {
          _meta: { "anthropic/requiresUserInteraction": true },
        }),
      },
      async (args) => {
        const checked = await input["~standard"].validate(args ?? {});
        const outcome = checked.issues
          ? errorOutcome(
              new InputError(
                `invalid ${spec.tool} input: ${checked.issues.map((i) => i.message).join("; ")}`,
              ),
            )
          : await runCommand(spec, commandArgs(spec, args, ctx), ctx);
        const document = resultDocument(spec.name, outcome);
        return {
          content: [{ type: "text", text: JSON.stringify(document) }],
          structuredContent: document,
          isError: document["ok"] !== true,
        };
      },
    );
  }
  return server;
}

/**
 * Serves the tools over MCP stdio with the official SDK until the input closes; no logs on
 * stdout. Refuses (exit 2 `settings_invalid`) to start in an environment the settings disallow,
 * and (exit 2 `key_tracked`) when a tracked file of the working directory's repository holds a key.
 */
export async function serveMcp(
  ctx: RunContext,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  checkContextEnvironment(ctx);
  checkTrackedKeys(process.cwd(), { settings: ctx.settings, ...(ctx.env && { env: ctx.env }) });
  const ended = new Promise<void>((done) => {
    input.once("end", done);
    input.once("close", done);
  });
  const handle = serveStdio(() => createServer(ctx), {
    transport: new StdioServerTransport(input, output),
    onerror: (error) => ctx.log(redact(`mcp: ${error.message}`)),
  });
  await ended;
  await handle.close();
}
