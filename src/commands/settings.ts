import { refusedVariables } from "../env.ts";
import { InputError } from "../errors.ts";
import { keyEnvOf, adapterOf } from "../providers/adapter.ts";
import { formatCheck, providerChecks } from "./spend.ts";
import { defineCommand } from "./types.ts";
import type { RunContext } from "./types.ts";

interface SettingsArgs {
  action?: string;
}

/** Whether a provider's key variable is set; never its value. */
function keyPresent(ctx: RunContext, id: string): { keyEnv: string | null; keyPresent: boolean } {
  const keyEnv = keyEnvOf(ctx.settings, id) ?? null;
  return { keyEnv, keyPresent: keyEnv !== null && Boolean(ctx.providers.env[keyEnv]) };
}

/** The settings as loaded, each provider with its adapter and whether its key is set. */
function shown(ctx: RunContext): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(ctx.settings.providers))
    providers[id] = { ...entry, adapter: adapterOf(ctx.settings, id).id, ...keyPresent(ctx, id) };
  return { ...ctx.settings, providers };
}

export const settingsCommand = defineCommand<SettingsArgs>({
  name: "settings",
  tool: "settings",
  summary: "show where the developer settings are, what they hold, and check them",
  details: `Actions (the settings tool takes the action as its action argument):
  path   the settings file, its directory and whether it exists
  show   the settings with every default filled; each provider with its adapter, key variable
         and whether the key is set, never its value
  check  per provider: key present, limit declared and verified (read where Assetgrove reads
         one), how its spend is reconciled (or unavailable); and the environment variables
         the settings refuse
All three are read-only; only a person edits the settings file.`,
  input: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "path, show or check",
        placeholder: "<path|show|check>",
      },
    },
    additionalProperties: false,
  },
  positionals: [{ name: "action" }],
  effect: { readOnly: true, spends: "never", writes: "none" },
  async run(args, ctx) {
    const { path, configDir, exists } = ctx.settings;
    if (args.action === "path") {
      return { exitCode: 0, fields: { path, configDir, exists }, human: path };
    }
    if (args.action === "show") {
      const settings = shown(ctx);
      return { exitCode: 0, fields: { settings }, human: JSON.stringify(settings, null, 2) };
    }
    if (args.action === "check") {
      const checks = await providerChecks(ctx, {});
      const providers = checks.map((c) => ({
        ...keyPresent(ctx, c.provider),
        ...c,
        reconcile: ctx.providers.providers.get(c.provider)?.billing.reconcile ?? "unavailable",
      }));
      const refused = refusedVariables(ctx.settings.environment.allow, ctx.env ?? process.env);
      const fields = { path, exists, providers, environment: { refused } };
      const human = [
        `settings ${path}${exists ? "" : " (no file: defaults)"}`,
        ...(checks.length === 0 ? ["no providers configured"] : checks.map(formatCheck)),
        refused.length === 0
          ? "environment: nothing refused"
          : `environment: refused ${refused.join(", ")}`,
      ].join("\n");
      return { exitCode: 0, fields, human };
    }
    throw new InputError("settings requires path, show or check");
  },
});
