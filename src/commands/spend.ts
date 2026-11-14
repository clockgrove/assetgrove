import { InputError } from "../errors.ts";
import { checkLimit } from "../limits.ts";
import type { LimitCheck } from "../limits.ts";
import { configuredProviders, spendLedger } from "../providers/index.ts";
import { WORK_ITEM_ENV, limitLabel } from "../spend.ts";
import { refusal, usd } from "./result.ts";
import { defineCommand } from "./types.ts";

interface SpendArgs {
  action?: string;
  provider?: string;
  workItem?: string;
  providerScript?: string;
}

export const spendCommand = defineCommand<SpendArgs>({
  name: "spend",
  tool: "spend",
  summary: "show the spend ledger and caps, or check each provider's declared limit",
  details: `Actions (the spend tool takes the action as its action argument):
  status  the ledger (<stateDir>/spend.jsonl), the caps from the developer settings, today's
          spend (the last 24 hours) and the work item (--work-item or ${WORK_ITEM_ENV})
  check   per configured provider (or --provider): the declared limit, what the provider
          reports (gateway credits, Tripo balance; others are declared only) and whether the
          two agree. A reading that contradicts the declared limit exits 3
          provider_limit_mismatch.
Spends nothing.`,
  input: {
    type: "object",
    properties: {
      action: { type: "string", description: "status or check", placeholder: "<status|check>" },
      provider: {
        type: "string",
        description: "check only this provider id",
        placeholder: "<id>",
      },
      workItem: {
        type: "string",
        description: "the work item the spend ledger counts against",
        placeholder: "<label>",
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
    if (args.action === "status") {
      const status = spendLedger(ctx, args.workItem).status();
      const daily = status.limits.find((l) => l.limit === "daily");
      const fields = {
        ledger: status.ledger,
        workItem: status.workItem,
        caps: ctx.settings.caps,
        today: { spentUsd: daily?.spentUsd ?? 0 },
        limits: status.limits,
      };
      const human = [
        `spend ledger ${status.ledger}`,
        `caps: run $${ctx.settings.caps.runUsd.toFixed(2)}, daily $${ctx.settings.caps.dailyUsd.toFixed(2)}, work item $${ctx.settings.caps.workItemUsd.toFixed(2)}`,
        `today (last 24 hours): ${usd(fields.today.spentUsd)} spent`,
        `work item: ${status.workItem ?? `none (--work-item or ${WORK_ITEM_ENV})`}`,
        ...status.limits.map(
          (l) =>
            `  ${limitLabel(l)} (${l.source}): ${usd(l.spentUsd)} spent, ${usd(l.remainingUsd)} left`,
        ),
      ].join("\n");
      return { exitCode: 0, fields, human };
    }
    if (args.action === "check") {
      const providers: LimitCheck[] = [];
      for (const { billing } of await configuredProviders(ctx, args.providerScript, args.provider))
        providers.push(await checkLimit(billing));
      const fields = { providers };
      const human = providers
        .map((p) => {
          const reading =
            p.reading === null
              ? (p.readingError ?? "no reading")
              : `${p.reading.source}: ${JSON.stringify(p.reading)}`;
          return `${p.provider} (${p.adapter}): ${p.declared ? `declared ${JSON.stringify(p.limit)}` : "no limit declared"}; ${p.verified ? "verified" : "not verified"}; ${reading}`;
        })
        .join("\n");
      const mismatched = providers.filter((p) => p.mismatch);
      if (mismatched.length > 0)
        return refusal(
          "provider_limit_mismatch",
          `the reading of ${mismatched.map((p) => p.provider).join(", ")} contradicts the declared limit`,
          fields,
          human,
        );
      return { exitCode: 0, fields, human: human || "no providers configured" };
    }
    throw new InputError("spend requires status or check");
  },
});
