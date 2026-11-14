import { refusedVariables } from "../env.ts";
import { InputError } from "../errors.ts";
import { checkLimit } from "../limits.ts";
import { adapterIdOf, checkAdapters, keyEnvOf } from "../providers/adapter.ts";
import { configuredProviders } from "../providers/index.ts";
import type { RunContext } from "./types.ts";
import { defineCommand } from "./types.ts";

interface SettingsArgs {
  action?: string;
  providerScript?: string;
}

/** Each configured provider's entry with its key variable and whether it is set; never a value. */
function providerSummary(ctx: RunContext): Record<string, Record<string, unknown>> {
  const adapters = checkAdapters(ctx.settings);
  const env = ctx.env ?? process.env;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, entry] of Object.entries(ctx.settings.providers)) {
    const adapter = adapters.get(id)!;
    const keyEnv = keyEnvOf(adapter, entry);
    out[id] = {
      ...entry,
      adapter: adapterIdOf(id, entry),
      keyEnv: keyEnv ?? null,
      keyPresent: keyEnv !== undefined && Boolean(env[keyEnv]),
    };
  }
  return out;
}

export const settingsCommand = defineCommand<SettingsArgs>({
  name: "settings",
  tool: "settings",
  summary: "show where the developer settings are, what they hold, and check them",
  details: `Actions (the settings tool takes the action as its action argument):
  path   the settings file (ASSETGROVE_CONFIG, else <configHome>/assetgrove/settings.json)
  show   the settings with every default filled; per provider its key variable and whether
         it is set, never a key
  check  per provider: key present, limit declared and verified; and the environment
         variables the settings would refuse
Read-only: nothing here writes the settings. A person edits the file.`,
  input: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "path, show or check",
        placeholder: "<path|show|check>",
      },
      providerScript: {
        type: "string",
        description: "the provider script a scripted provider's limit reading comes from",
        placeholder: "<module>",
      },
    },
    additionalProperties: false,
  },
  positionals: [{ name: "action" }],
  effect: { readOnly: true, spends: "never", writes: "none" },
  async run(args, ctx) {
    const s = ctx.settings;
    if (args.action === "path") {
      const fields = { path: s.path, configDir: s.configDir, exists: s.exists };
      return { exitCode: 0, fields, human: s.path };
    }
    if (args.action === "show") {
      const fields = {
        path: s.path,
        exists: s.exists,
        stateDir: s.stateDir,
        mode: s.mode,
        ...(s.headless && { headless: s.headless }),
        caps: s.caps,
        providers: providerSummary(ctx),
        roles: s.roles,
        routes: s.routes,
        extensions: s.extensions,
        environment: s.environment,
        reconcile: s.reconcile,
        spend: s.spend,
        commands: s.commands,
        promptPolicy: s.promptPolicy,
        confirmedBy: s.confirmedBy,
      };
      return { exitCode: 0, fields, human: JSON.stringify(fields, null, 2) };
    }
    if (args.action === "check") {
      const summary = providerSummary(ctx);
      const refused = refusedVariables(s.environment.allow, ctx.env ?? process.env);
      const providers = [];
      for (const { billing } of await configuredProviders(ctx, args.providerScript)) {
        const check = await checkLimit(billing, { refused });
        providers.push({
          ...check,
          keyEnv: summary[billing.provider]?.["keyEnv"] ?? null,
          keyPresent: summary[billing.provider]?.["keyPresent"] ?? false,
        });
      }
      const fields = { path: s.path, exists: s.exists, mode: s.mode, providers, refused };
      const human = [
        `settings ${s.path}${s.exists ? "" : " (no file: defaults)"}`,
        ...providers.map(
          (p) =>
            `  ${p.provider} (${p.adapter}): key ${p.keyPresent ? "present" : "absent"}, limit ` +
            `${p.declared ? "declared" : "undeclared"}, ${p.verified ? "verified" : "not verified"}`,
        ),
        ...(refused.length > 0 ? [`  refused environment: ${refused.join(", ")}`] : []),
      ].join("\n");
      return { exitCode: 0, fields, human };
    }
    throw new InputError("settings requires path, show or check");
  },
});
