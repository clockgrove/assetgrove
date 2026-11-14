/**
 * The one RunContext the CLI and the MCP server build: developer settings loaded once, the log,
 * and the provider options the server was started with.
 */
import { checkEnvironment } from "../env.ts";
import type { Env } from "../env.ts";
import { loadSettings } from "../settings.ts";
import type { CommandSpec, RunContext } from "./types.ts";

export interface ContextOptions {
  log: (message: string) => void;
  /** The environment settings are found from; process.env when absent. */
  env?: Env;
  /** The working directory whose Git top level the settings file may not be inside. */
  cwd?: string;
  /** The server's --provider-script, given to every tool call that takes one. */
  providerScript?: string;
  /** The server's --work-item, given to every tool call that names none. */
  workItem?: string;
}

/** Loads the developer settings once and builds the context every command of this process runs in. */
export function createRunContext(options: ContextOptions): RunContext {
  const settings = loadSettings({
    ...(options.env && { env: options.env }),
    ...(options.cwd && { cwd: options.cwd }),
  });
  return {
    settings,
    log: options.log,
    ...(options.providerScript !== undefined && { providerScript: options.providerScript }),
    ...(options.workItem !== undefined && { workItem: options.workItem }),
    ...(options.env && { env: options.env }),
  };
}

/** Whether a command can spend; the environment is checked before every such command. */
export function isPaid(spec: CommandSpec): boolean {
  return spec.effect.spends !== "never";
}

/**
 * Throws `settings_invalid` (exit 2) when a variable that can redirect or unwrap TLS is set and
 * the settings' `environment.allow` does not list it. Run at server start and before every paid
 * command.
 */
export function checkContextEnvironment(ctx: RunContext): void {
  checkEnvironment(ctx.settings.environment.allow, ctx.env ?? process.env);
}
