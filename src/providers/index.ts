/**
 * The providers a command calls, each made by its adapter from the developer settings
 * (src/providers/adapter.ts) and routed by them (src/routes.ts), and the spend ledger of the
 * invocation.
 */
import type { RunContext } from "../commands/types.ts";
import type { ToolContext } from "../mcp.ts";
import { SpendLedger } from "../spend.ts";
import { loadScript } from "./script.ts";
import { ProviderSet } from "./set.ts";

export { loadScript } from "./script.ts";
export { ProviderSet, suggestRoles } from "./set.ts";
export type { ServedBy, SuggestedRole } from "./set.ts";

/** What provider setup reads from the run context: the settings and the environment. */
export type ProviderContext = Pick<RunContext, "settings" | "env" | "prompt">;

/**
 * The providers and routes of the developer settings (src/providers/set.ts); `--provider-script`,
 * when given, is the module of every configured scripted provider. Makes no call.
 */
export async function providerSet(
  providerScript: string | undefined,
  ctx: ProviderContext,
): Promise<ProviderSet> {
  const script = providerScript !== undefined ? await loadScript(providerScript, ctx) : undefined;
  return ProviderSet.fromSettings(ctx.settings, {
    ...(ctx.env && { env: ctx.env }),
    ...(script && { script }),
  });
}

/**
 * The cross-run spend ledger of this invocation (src/spend.ts): `<stateDir>/spend.jsonl` with the
 * settings' caps, the work item from --work-item or ASSETGROVE_WORK_ITEM.
 */
export function spendLedger(ctx: ProviderContext, workItem: string | undefined): SpendLedger {
  return SpendLedger.fromSettings(ctx.settings, {
    ...(workItem !== undefined && { workItem }),
    ...(ctx.env && { env: ctx.env }),
  });
}

/**
 * The context of the planning tools (plan, apply, mcp): the providers and routes of the settings,
 * the spend ledger and the run cap.
 */
export async function planningContext(
  providerScript: string | undefined,
  workItem: string | undefined,
  ctx: ProviderContext,
): Promise<ToolContext> {
  return {
    provider: await providerSet(providerScript, ctx),
    ledger: spendLedger(ctx, workItem),
    runCapUsd: ctx.settings.caps.runUsd,
  };
}
