import { ConfirmationError } from "../approvals.ts";
import { savePending } from "../confirm/pending.ts";
import { describeRequest } from "../confirm/prompt.ts";
import { refusedVariables } from "../env.ts";
import { InputError } from "../errors.ts";
import { checkLimit } from "../limits.ts";
import { createProviders } from "../providers/adapter.ts";
import type { ConfiguredProvider } from "../providers/adapter.ts";
import { LIMIT_KINDS } from "../settings.ts";
import type { ProviderLimit } from "../settings.ts";
import {
  CAP_FIELDS,
  applySettingsChange,
  checkChange,
  editedChange,
  settingsRequest,
} from "../settings-write.ts";
import type { ChangeResult, SettingsChange } from "../settings-write.ts";
import { refusal } from "./result.ts";
import { defineCommand } from "./types.ts";
import type { Outcome, RunContext } from "./types.ts";

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
Read-only: never writes the settings; settings change proposes a change for a person to confirm.`,
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
    const refused = refusedVariables(s.environment.allow, ctx.env);
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

interface SettingsChangeArgs {
  runUsd?: number;
  dailyUsd?: number;
  workItemUsd?: number;
  provider?: string;
  limitKind?: string;
  limitUsd?: number;
  limitPeriod?: string;
  acceptUnlimited?: boolean;
  acknowledgeHolds?: string[];
}

/** The change a call proposes, from its flat arguments; exit 2 for a limit field with no provider. */
function proposedChange(args: SettingsChangeArgs): SettingsChange {
  const caps: SettingsChange["caps"] = {};
  for (const field of CAP_FIELDS) if (args[field] !== undefined) caps[field] = args[field];
  const limitFields = [args.limitKind, args.limitUsd, args.limitPeriod, args.acceptUnlimited];
  if (args.provider === undefined && limitFields.some((v) => v !== undefined))
    throw new InputError("a limit needs --provider <id>: the provider whose limit it is");
  if (args.provider !== undefined && args.limitKind === undefined)
    throw new InputError("--provider needs --limit-kind: the kind of limit its key carries");
  return {
    ...(Object.keys(caps).length > 0 && { caps }),
    ...(args.provider !== undefined && {
      limit: {
        provider: args.provider,
        limit: {
          kind: args.limitKind as ProviderLimit["kind"],
          ...(args.limitUsd !== undefined && { usd: args.limitUsd }),
          ...(args.limitPeriod !== undefined && { period: args.limitPeriod }),
          ...(args.acceptUnlimited !== undefined && { acceptUnlimited: args.acceptUnlimited }),
        },
      },
    }),
    ...(args.acknowledgeHolds !== undefined && { acknowledgeHolds: args.acknowledgeHolds }),
  };
}

function changeOutcome(result: ChangeResult, method: string, id: string): Outcome {
  const human = [
    result.written.length > 0
      ? `wrote ${result.written.join(", ")} to ${result.path} (confirmed by ${method})`
      : `wrote nothing to ${result.path}`,
    ...result.notWritten.map((n) => `  not written: ${n.field}: ${n.reason}`),
  ].join("\n");
  return { exitCode: 0, fields: { id, method, ...result }, human };
}

export const settingsChangeCommand = defineCommand<SettingsChangeArgs>({
  name: "settings change",
  tool: "settings_change",
  summary: "propose caps, a provider limit or hold acknowledgements for a person to confirm",
  details: `Proposes a change to the developer settings that only a person's confirmation writes:
the caps (--run-usd, --daily-usd, --work-item-usd), one provider's limit (--provider with
--limit-kind, --limit-usd, --limit-period and --accept-unlimited) and spend holds to acknowledge
(--acknowledge-holds). An MCP client with form elicitation shows the person a form with the
proposed values filled in; on accept the values the person submitted are written. Without one it
exits 8 confirmation_required, the request saved to <stateDir>/pending/<id>.json, and
\`assetgrove confirm <id>\` at a terminal writes it (method terminal). Writes only those fields and
a confirmedBy entry per field path; every other byte of the file stays as it was. A limit for a
core adapter id with no provider entry creates the entry with only limit. Kind unlimited is written
only with acceptUnlimited true. Headless settings exit 8 confirmation_required and write nothing.
Exits 2 for a provider that is neither in the settings nor a core adapter id, or a hold id
<stateDir>/holds.jsonl does not list. Declining exits 8 confirmation_declined.`,
  input: {
    type: "object",
    properties: {
      runUsd: {
        type: "number",
        description: "the proposed run cap (caps.runUsd), USD",
        minimum: 0,
      },
      dailyUsd: {
        type: "number",
        description: "the proposed daily cap (caps.dailyUsd), USD",
        minimum: 0,
      },
      workItemUsd: {
        type: "number",
        description: "the proposed work-item cap (caps.workItemUsd), USD",
        minimum: 0,
      },
      provider: {
        type: "string",
        description:
          "the provider id whose limit is proposed: a settings entry, or a core adapter id (which creates an entry holding only the limit)",
        placeholder: "<id>",
      },
      limitKind: {
        type: "string",
        description: `the limit's kind: ${LIMIT_KINDS.join(", ")}`,
        placeholder: "<kind>",
      },
      limitUsd: { type: "number", description: "the limit in USD", minimum: 0 },
      limitPeriod: {
        type: "string",
        description: "the period the limit resets on, for example monthly",
        placeholder: "<period>",
      },
      acceptUnlimited: {
        type: "boolean",
        description: 'accept a key with no limit; kind "unlimited" is written only with it',
      },
      acknowledgeHolds: {
        type: "array",
        items: { type: "string" },
        description: "the spend hold ids to acknowledge (spend.acknowledgedHolds)",
        placeholder: "<hold>",
      },
    },
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "never", writes: "settings" },
  confirm: "settings",
  async run(args, ctx) {
    const settings = ctx.settings;
    const change = proposedChange(args);
    checkChange(change, settings);
    const request = settingsRequest(settings.path, change);
    if (settings.mode === "headless") {
      return refusal(
        "confirmation_required",
        "headless settings cannot change the developer settings: a person runs settings change with attended settings",
        { id: request.id, kind: request.kind, request: request.details, written: [] },
        describeRequest(request),
      );
    }
    const prompt = ctx.prompt;
    if (prompt?.method === "elicitation" && prompt.edit) {
      const content = await prompt.edit(request);
      if (content === undefined)
        throw new ConfirmationError(
          "confirmation_declined",
          `the settings change ${request.id} was declined`,
        );
      const accepted = editedChange(request.body.change, content);
      const channel = prompt.recordFields?.(request);
      const result = await applySettingsChange(settings, accepted, {
        method: "elicitation",
        ...(channel?.client !== undefined && { client: channel.client }),
      });
      return changeOutcome(result, "elicitation", request.id);
    }
    await savePending(settings.stateDir, request);
    throw new ConfirmationError(
      "confirmation_required",
      `${request.summary} needs a person's confirmation; run: assetgrove confirm ${request.id}`,
      {
        kind: "settings",
        id: request.id,
        summary: request.summary,
        confirmCommand: `assetgrove confirm ${request.id}`,
      },
    );
  },
});
