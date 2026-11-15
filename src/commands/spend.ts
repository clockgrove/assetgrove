import { InputError } from "../errors.ts";
import { checkLimit } from "../limits.ts";
import type { LimitCheck } from "../limits.ts";
import { createProviders, providerOfAdapter } from "../providers/adapter.ts";
import { loadScript, spendLedger } from "../providers/index.ts";
import { limitLabel } from "../spend.ts";
import { refusal, usd } from "./result.ts";
import { defineCommand } from "./types.ts";

interface SpendArgs {
  action?: string;
  provider?: string;
  workItem?: string;
  providerScript?: string;
}

const ACTIONS = ["status", "check"] as const;

function describe(p: LimitCheck): string {
  const limit = p.limit
    ? `declared (${p.limit.kind}${p.limit.usd !== undefined ? ` $${p.limit.usd}` : ""})`
    : "not declared";
  const reading =
    p.reading?.balanceUsd !== undefined ? `, reading $${p.reading.balanceUsd.toFixed(2)}` : "";
  const note = p.note !== undefined ? ` (${p.note})` : "";
  return `${p.provider} (${p.adapter}): limit ${limit}, ${p.verified ? "verified" : "not verified"}${reading}${note}`;
}

export const spendCommand = defineCommand<SpendArgs>({
  name: "spend",
  tool: "spend",
  summary: "show the spend ledger and caps, or check each provider's declared limit",
  details: `Actions (the spend tool takes the action as its action argument):
  status  the ledger (<stateDir>/spend.jsonl), the caps from the settings, today's spend (last 24
          hours) and the work item (--work-item or ASSETGROVE_WORK_ITEM) with its spend
  check   per configured provider (--provider narrows it): whether a limit is declared, the
          provider's reading where it gives one to an ordinary key (gateway credits, Tripo
          balance) and whether the reading verifies the limit. Exits 3 provider_limit_mismatch
          when a reading contradicts a declared limit.
Spends nothing and writes nothing.`,
  input: {
    type: "object",
    properties: {
      action: { type: "string", description: "status or check", placeholder: "<status|check>" },
      provider: {
        type: "string",
        description: "check only this provider (its settings id)",
        placeholder: "<id>",
      },
      workItem: {
        type: "string",
        description: "the work item whose spend status reports",
        placeholder: "<label>",
      },
      providerScript: {
        type: "string",
        description: "the scripted provider's module, whose limitReading check reads",
        placeholder: "<module>",
      },
    },
    additionalProperties: false,
  },
  positionals: [{ name: "action" }],
  effect: { readOnly: true, spends: "never", writes: "none" },
  async run(args, ctx) {
    const action = args.action;
    if (action === undefined || !(ACTIONS as readonly string[]).includes(action))
      throw new InputError(`spend requires ${ACTIONS.join(" or ")}`);
    if (action === "status") {
      const status = spendLedger(ctx, args.workItem ?? ctx.workItem).status();
      const daily = status.limits.find((l) => l.limit === "daily");
      const fields = { ...status, today: { spentUsd: daily?.spentUsd ?? 0 } };
      const { caps } = status;
      const human = [
        `spend ledger ${status.ledger}`,
        `caps: run $${caps.runUsd.toFixed(2)}, daily $${caps.dailyUsd.toFixed(2)}, work item $${caps.workItemUsd.toFixed(2)}`,
        `work item: ${status.workItem ?? "none"}`,
        ...status.limits.map(
          (l) => `  ${limitLabel(l)}: ${usd(l.spentUsd)} spent, ${usd(l.remainingUsd)} left`,
        ),
      ].join("\n");
      return { exitCode: 0, fields, human };
    }

    const providerScript = args.providerScript ?? ctx.providerScript;
    const script = providerScript !== undefined ? await loadScript(providerScript, ctx) : undefined;
    const options = { ...(ctx.env && { env: ctx.env }), ...(script && { script }) };
    const configured = createProviders(ctx.settings, {
      ...options,
      ...(ctx.extensions && { adapters: ctx.extensions.adapters }),
    });
    if (script !== undefined && !configured.some((c) => c.adapter.id === "scripted"))
      configured.push(providerOfAdapter(ctx.settings, "scripted", options));
    const selected =
      args.provider === undefined ? configured : configured.filter((c) => c.id === args.provider);
    if (args.provider !== undefined && selected.length === 0)
      throw new InputError(`no provider "${args.provider}" in the developer settings`);
    const providers: LimitCheck[] = [];
    for (const c of selected) providers.push(await checkLimit(c.provider.billing));
    const fields = { providers };
    const human = providers.map(describe).join("\n") || "no providers configured";
    const mismatch = providers.find((p) => p.mismatch);
    if (mismatch !== undefined)
      return refusal(
        "provider_limit_mismatch",
        `provider "${mismatch.provider}": ${mismatch.note ?? "the reading contradicts the declared limit"}`,
        fields,
        human,
      );
    return { exitCode: 0, fields, human };
  },
});
