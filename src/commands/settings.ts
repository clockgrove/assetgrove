import { refusedVariables } from "../env.ts";
import { InputError } from "../errors.ts";
import { checkLimit } from "../limits.ts";
import { createProviders } from "../providers/adapter.ts";
import type { ConfiguredProvider } from "../providers/adapter.ts";
import { defineCommand } from "./types.ts";
import type { RunContext } from "./types.ts";

interface SettingsArgs {
  action?: string;
}

const ACTIONS = ["path", "show", "check"] as const;

/** One provider as `settings show` lists it: its entry, its adapter and whether its key is set. */
function shown(configured: ConfiguredProvider) {
  return {
    ...configured.settings,
    adapter: configured.adapter.id,
    keyEnv: configured.keyEnv ?? null,
    keyPresent: configured.keyPresent,
  };
}

function providers(ctx: RunContext): ConfiguredProvider[] {
  return createProviders(ctx.settings, {
    ...(ctx.env && { env: ctx.env }),
    ...(ctx.extensions && { adapters: ctx.extensions.adapters }),
  });
}

export const settingsCommand = defineCommand<SettingsArgs>({
  name: "settings",
  tool: "settings",
  summary: "print where the developer settings are, what they hold, or check them",
  details: `Actions (the settings tool takes the action as its action argument):
  path   the settings file and whether it exists, the config and state directories
  show   the settings with every default filled; per provider the key variable's name and
         whether it is set, never a key
  check  per provider: key present, limit declared and verified against the provider's reading,
         how spend is reconciled (or unavailable); and the environment variables refused
Read-only: never writes the settings.`,
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
    const action = args.action;
    if (action === undefined || !(ACTIONS as readonly string[]).includes(action))
      throw new InputError(`settings requires ${ACTIONS.join(", ")}`);
    const s = ctx.settings;
    const where = `${s.path}${s.exists ? "" : " (no file: defaults apply)"}`;
    if (action === "path") {
      const fields = {
        path: s.path,
        exists: s.exists,
        configDir: s.configDir,
        stateDir: s.stateDir,
      };
      return { exitCode: 0, fields, human: where };
    }
    if (action === "show") {
      const settings = {
        path: s.path,
        exists: s.exists,
        configDir: s.configDir,
        stateDir: s.stateDir,
        mode: s.mode,
        ...(s.headless && { headless: s.headless }),
        caps: s.caps,
        providers: Object.fromEntries(providers(ctx).map((p) => [p.id, shown(p)])),
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
      return { exitCode: 0, fields: { settings }, human: JSON.stringify(settings, null, 2) };
    }
    const checks = [];
    for (const configured of providers(ctx)) {
      const billing = configured.provider.billing;
      const limit = await checkLimit(billing);
      checks.push({
        provider: configured.id,
        adapter: configured.adapter.id,
        paid: billing.paid,
        keyEnv: configured.keyEnv ?? null,
        keyPresent: configured.keyPresent,
        limit: {
          declared: limit.declared,
          verified: limit.verified,
          reading: limit.reading,
          ...(limit.note !== undefined && { note: limit.note }),
        },
        reconcile: billing.reconcile,
      });
    }
    const refused = refusedVariables(s.environment.allow, ctx.env ?? process.env);
    const fields = { path: s.path, providers: checks, environment: { refused } };
    const human = [
      `settings ${where}`,
      ...checks.map(
        (c) =>
          `  ${c.provider} (${c.adapter}, ${c.paid ? "paid" : "free"}): key ${c.keyEnv ?? "none"} ` +
          `${c.keyPresent ? "set" : "not set"}; limit ${c.limit.declared ? "declared" : "not declared"}` +
          `${c.limit.verified ? ", verified" : ""}; reconcile ${c.reconcile}`,
      ),
      refused.length > 0 ? `  refused environment: ${refused.join(", ")}` : "  environment: ok",
    ].join("\n");
    return { exitCode: 0, fields, human };
  },
});
