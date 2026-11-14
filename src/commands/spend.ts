import { InputError } from "../errors.ts";
import { checkLimit, mismatchError } from "../limits.ts";
import type { LimitCheck } from "../limits.ts";
import { loadScript, spendLedger } from "../providers/index.ts";
import type { BilledProvider } from "../providers/adapter.ts";
import { refusal, usd } from "./result.ts";
import { defineCommand } from "./types.ts";
import type { RunContext } from "./types.ts";

interface SpendArgs {
  action?: string;
  provider?: string;
  workItem?: string;
  providerScript?: string;
}

/**
 * The providers of the settings, each with its billing; with `--provider-script`, the scripted
 * provider answers from that module (its limit reader included).
 */
async function configured(
  ctx: RunContext,
  providerScript: string | undefined,
): Promise<Map<string, BilledProvider>> {
  const providers = new Map(ctx.providers.providers);
  if (providerScript) {
    const { id, provider } = ctx.providers.scripted(await loadScript(providerScript));
    providers.set(id, provider);
  }
  return providers;
}

/**
 * Each configured provider's limit: declared, verified and the reading, read where the adapter can
 * (gateway credits, Tripo balance, a script's reader) and its key is set.
 */
export async function providerChecks(
  ctx: RunContext,
  options: { provider?: string | undefined; providerScript?: string | undefined },
): Promise<LimitCheck[]> {
  const providers = await configured(ctx, options.providerScript);
  if (options.provider !== undefined && !providers.has(options.provider))
    throw new InputError(
      `no provider "${options.provider}" in the settings file; configured: ${[...providers.keys()].join(", ") || "none"}`,
    );
  const checks: LimitCheck[] = [];
  for (const [id, provider] of providers) {
    if (options.provider !== undefined && id !== options.provider) continue;
    checks.push(await checkLimit(provider.billing, { read: true }));
  }
  return checks;
}

function formatCheck(c: LimitCheck): string {
  const limit = c.limit
    ? `${c.limit.kind}${c.limit.usd !== undefined ? ` ${usd(c.limit.usd)}` : ""}`
    : "none";
  const reading =
    c.reading === null
      ? (c.readingError ?? "not read")
      : `${c.reading.source}: ${c.reading.balanceUsd !== undefined ? usd(c.reading.balanceUsd) : `${c.reading.credits} credits`}`;
  return `${c.provider} (${c.adapter}, ${c.paid ? "paid" : "free"}): limit ${limit}, declared ${c.declared}, verified ${c.verified}; reading ${reading}${c.mismatch ? " (contradicts the declared limit)" : ""}`;
}

export const spendCommand = defineCommand<SpendArgs>({
  name: "spend",
  tool: "spend",
  summary: "show the spend ledger and caps, or check each provider's own limit",
  details: `Actions (the spend tool takes the action as its action argument):
  status  the ledger (<stateDir>/spend.jsonl), the caps from the settings, the work item and
          what is spent today (the last 24 hours) and against each cap
  check   for each configured provider (or --provider), whether a limit is declared, the
          provider's own reading where Assetgrove reads one (gateway credits, Tripo balance)
          and whether the reading verifies it; a reading that contradicts the declared limit
          exits 3 provider_limit_mismatch. Reads spend nothing.`,
  input: {
    type: "object",
    properties: {
      action: { type: "string", description: "status or check", placeholder: "<status|check>" },
      provider: {
        type: "string",
        description: "check only this settings provider",
        placeholder: "<id>",
      },
      workItem: {
        type: "string",
        description: "the work item whose spend status shows",
        placeholder: "<label>",
      },
      providerScript: {
        type: "string",
        description: "the scripted provider answers from this module, its limit reader included",
        placeholder: "<module>",
      },
    },
    additionalProperties: false,
  },
  positionals: [{ name: "action" }],
  effect: { readOnly: true, spends: "never", writes: "none" },
  async run(args, ctx) {
    if (args.action === "status") {
      const ledger = spendLedger(ctx, args.workItem);
      const status = ledger.status();
      const today = status.limits.find((l) => l.limit === "daily")?.spentUsd ?? 0;
      const fields = {
        ledger: status.ledger,
        caps: ctx.settings.caps,
        workItem: status.workItem,
        todayUsd: today,
        limits: status.limits,
      };
      const human = [
        `spend ledger ${status.ledger}`,
        `caps: run ${usd(ctx.settings.caps.runUsd)}, daily ${usd(ctx.settings.caps.dailyUsd)}, work item ${usd(ctx.settings.caps.workItemUsd)}`,
        `today (last 24 hours): ${usd(today)}`,
        `work item: ${status.workItem ?? "none"}`,
        ...status.limits.map(
          (l) =>
            `  ${l.limit}: ${usd(l.spentUsd)} spent, ${usd(l.remainingUsd)} left (${l.source})`,
        ),
      ].join("\n");
      return { exitCode: 0, fields, human };
    }
    if (args.action === "check") {
      const providers = await providerChecks(ctx, args);
      const fields = { providers };
      const human =
        providers.length === 0 ? "no providers configured" : providers.map(formatCheck).join("\n");
      const mismatch = mismatchError(providers);
      if (mismatch) return refusal("provider_limit_mismatch", mismatch.message, fields, human);
      return { exitCode: 0, fields, human };
    }
    throw new InputError("spend requires status or check");
  },
});

export { formatCheck };
