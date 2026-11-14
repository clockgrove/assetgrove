import type { Billing, GenerationProvider } from "../gateway/provider.ts";
import { RoutedProvider } from "../gateway/routed.ts";
import type { ToolContext } from "../mcp.ts";
import { CHARACTER_3D_KIND } from "../model3d/profile.ts";
import type { RunContext } from "../commands/types.ts";
import { SpendLedger } from "../spend.ts";
import type { AssetSpec } from "../types.ts";
import { keyEnvOf } from "./adapter.ts";
import { loadScript } from "./script.ts";

export { loadScript } from "./script.ts";

/** A provider and the name its calls are recorded under (its settings provider id). */
export interface NamedProvider {
  provider: GenerationProvider;
  name: string;
}

/** The provider a run's context needs: its settings, its created providers and its environment. */
type ProviderContext = Pick<RunContext, "providers">;

/**
 * The scripted provider of --provider-script, under the settings provider whose adapter is
 * `scripted` (else the id `scripted`); paid only when the script says so.
 */
export async function scriptedFrom(
  ctx: ProviderContext,
  providerScript: string | undefined,
): Promise<NamedProvider | undefined> {
  if (!providerScript) return undefined;
  const { id, provider } = ctx.providers.scripted(await loadScript(providerScript));
  return { provider, name: id };
}

/** The gateway: the first settings provider with its adapter, else the core adapter. */
export function gatewayProvider(ctx: ProviderContext): NamedProvider {
  const { id, provider } = ctx.providers.byAdapter("vercel-ai-gateway");
  return { provider, name: id };
}

/** The provider of a run: the --provider-script module when given, else the gateway. */
export async function providerFor(
  ctx: ProviderContext,
  providerScript: string | undefined,
): Promise<NamedProvider> {
  return (await scriptedFrom(ctx, providerScript)) ?? gatewayProvider(ctx);
}

/**
 * The billing a dry run counts against, loading (and so checking) --provider-script when given;
 * without one, the gateway's, which is paid.
 */
export async function dryRunBilling(
  ctx: ProviderContext,
  providerScript: string | undefined,
): Promise<Billing | undefined> {
  return (await providerFor(ctx, providerScript)).provider.billing;
}

/**
 * The real provider of a stage run: 3D characters make their 3D calls on Tripo and their identity
 * calls on the gateway; other kinds use the gateway alone.
 */
export function stageProvider(
  ctx: ProviderContext,
  spec: AssetSpec,
): { provider: GenerationProvider; providerName: string } {
  const gateway = ctx.providers.byAdapter("vercel-ai-gateway");
  if (spec.kind !== CHARACTER_3D_KIND)
    return { provider: gateway.provider, providerName: gateway.id };
  const tripo = ctx.providers.byAdapter("tripo");
  return {
    provider: new RoutedProvider({ gateway: gateway.provider, models: tripo.provider }),
    providerName: `${tripo.id}+${gateway.id}`,
  };
}

/**
 * The cross-run spend ledger of this invocation (src/spend.ts): `<stateDir>/spend.jsonl` and the
 * caps of the settings, the work item from --work-item or ASSETGROVE_WORK_ITEM.
 */
export function spendLedger(
  ctx: Pick<RunContext, "settings" | "env">,
  workItem: string | undefined,
): SpendLedger {
  return SpendLedger.fromSettings(ctx.settings, {
    ...(workItem !== undefined && { workItem }),
    ...(ctx.env !== undefined && { env: ctx.env }),
  });
}

/**
 * The context of the planning tools (plan, apply, mcp): the scripted provider, else the gateway
 * when its key is set, else no provider. The plan's cap never exceeds the settings' run cap.
 */
export async function planningContext(
  ctx: Pick<RunContext, "settings" | "env" | "providers">,
  providerScript: string | undefined,
  workItem: string | undefined,
): Promise<ToolContext> {
  const ledger = spendLedger(ctx, workItem);
  const capCeilingUsd = ctx.settings.caps.runUsd;
  const scripted = await scriptedFrom(ctx, providerScript);
  if (scripted)
    return { provider: scripted.provider, providerName: scripted.name, ledger, capCeilingUsd };
  const gateway = gatewayProvider(ctx);
  const keyEnv = keyEnvOf(ctx.settings, gateway.name);
  if (keyEnv !== undefined && ctx.providers.env[keyEnv])
    return { provider: gateway.provider, providerName: gateway.name, ledger, capCeilingUsd };
  return { ledger, capCeilingUsd };
}
