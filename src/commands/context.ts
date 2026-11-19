/**
 * The one RunContext the CLI and the MCP server build: developer settings loaded fresh for each
 * CLI command and each tool call, the log, and the provider options the server was started with.
 */
import { checkEnvironment, envUses } from "../env.ts";
import type { Env } from "../env.ts";
import { ttyPort } from "../confirm/prompt.ts";
import { loadExtensions } from "../extensions/registry.ts";
import { createProviders } from "../providers/adapter.ts";
import { registerKeyEnv } from "../redact.ts";
import { loadSettings } from "../settings.ts";
import type { CommandSpec, RunContext } from "./types.ts";

export interface ContextOptions {
  log: (message: string) => void;
  /** The environment settings are found from; the process environment when absent. */
  env?: Env;
  /** The working directory whose Git top level the settings file may not be inside. */
  cwd?: string;
  /** The command's `--target`, whose project the settings file may not be inside either. */
  target?: string;
  /** The command's input files, whose projects the settings file may not be inside either. */
  inputs?: readonly string[];
  /** The server's --provider-script, given to every tool call that takes one. */
  providerScript?: string;
  /** The server's --work-item, given to every tool call that names none. */
  workItem?: string;
  /** True for the CLI: a person at a TTY (stdin and stderr) can be asked inline. */
  interactive?: boolean;
}

/**
 * The arguments that name a directory a command writes into or reads from as a whole: `--target`
 * (pick, write-families) and init's directory.
 */
const TARGET_PROPERTIES: readonly string[] = ["target", "directory"];

/** The arguments that name a file or directory a command reads. */
const INPUT_PROPERTIES: readonly string[] = [
  "albedo",
  "bible",
  "brief",
  "cases",
  "derivation",
  "file",
  "grouping",
  "import",
  "imports",
  "inputs",
  "keyPose",
  "lockBible",
  "model",
  "plan",
  "profile",
  "provenance",
  "providerScript",
  "recipe",
  "recipes",
  "source",
  "sourceProvenance",
  "run",
  "runOptions",
  "sheet",
  "spec",
  "strip",
  "template",
];

/**
 * The paths of a command's arguments whose projects the settings file may not be inside (design
 * section 2): its target and every input file.
 */
export function settingsScope(
  args: Record<string, unknown>,
): Pick<ContextOptions, "target" | "inputs"> {
  const strings = (name: string): string[] => {
    const value = args[name];
    if (typeof value === "string" && value !== "") return [value];
    if (Array.isArray(value))
      return value.filter((v): v is string => typeof v === "string" && v !== "");
    return [];
  };
  const target = TARGET_PROPERTIES.flatMap(strings)[0];
  const inputs = INPUT_PROPERTIES.flatMap(strings);
  return { ...(target !== undefined && { target }), ...(inputs.length > 0 && { inputs }) };
}

/**
 * Loads the developer settings and the extensions they list, and builds the context one command
 * runs in. The CLI builds it once per command and the MCP server once per tool call, so a change
 * to the settings file holds from the next call on.
 */
export async function createRunContext(options: ContextOptions): Promise<RunContext> {
  const settings = loadSettings({
    ...(options.env && { env: options.env }),
    ...(options.cwd && { cwd: options.cwd }),
    ...(options.target !== undefined && { target: options.target }),
    ...(options.inputs && { inputs: options.inputs }),
  });
  // Extensions first: a listed package that cannot load refuses (exit 2) before anything else.
  const extensions = await loadExtensions(settings, options.cwd ?? process.cwd());
  // Each provider is made by its adapter now, so an adapter-aware refusal (an unknown adapter, a
  // baseURL the adapter does not take) exits 2 settings_invalid before any command runs.
  const configured = createProviders(settings, {
    ...(options.env && { env: options.env }),
    adapters: extensions.adapters,
  });
  // Every key variable in play is redacted from here on, whether or not a guard runs: each
  // provider's and each adapter's default.
  registerKeyEnv([
    ...configured.flatMap((c) => (c.keyEnv !== undefined ? [c.keyEnv] : [])),
    ...extensions.adapters.flatMap((a) => (a.defaultKeyEnv !== undefined ? [a.defaultKeyEnv] : [])),
  ]);
  const prompt = options.interactive ? ttyPort() : undefined;
  return {
    settings,
    extensions,
    log: options.log,
    ...(prompt && { prompt }),
    ...(options.providerScript !== undefined && { providerScript: options.providerScript }),
    ...(options.workItem !== undefined && { workItem: options.workItem }),
    ...(options.env && { env: options.env }),
  };
}

/** Whether a command can spend; the environment is checked before every such command. */
export function isPaid(spec: CommandSpec): boolean {
  return spec.effect.spends !== "never";
}

/** Whether a command can spend under these settings (its `spendsWith`, else `isPaid`). */
export function canSpend(spec: CommandSpec, ctx: RunContext): boolean {
  return isPaid(spec) && (spec.spendsWith?.(ctx) ?? true);
}

/**
 * Throws `settings_invalid` (exit 2) when a variable that can redirect or unwrap TLS is set and
 * the settings' `environment.allow` does not list it. Run at server start and before every command
 * that can send a key (src/commands/runner.ts).
 */
export function checkContextEnvironment(ctx: RunContext): void {
  checkEnvironment(ctx.settings.environment.allow, ctx.env, envUses(ctx.settings));
}
