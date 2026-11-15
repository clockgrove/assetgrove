/**
 * The providers a command calls, each made by its adapter from the developer settings
 * (src/providers/adapter.ts), and the spend ledger of the invocation.
 */
import type { RunContext } from "../commands/types.ts";
import type { Billing, GenerationProvider } from "../gateway/provider.ts";
import type { Script } from "../gateway/scripted.ts";
import { RoutedProvider } from "../gateway/routed.ts";
import type { ToolContext } from "../mcp.ts";
import { CHARACTER_3D_KIND } from "../model3d/profile.ts";
import { SpendLedger } from "../spend.ts";
import type { AssetSpec } from "../types.ts";
import { providerOfAdapter } from "./adapter.ts";
import { loadScript } from "./script.ts";

export { loadScript } from "./script.ts";

/** What provider setup reads from the run context: the settings and the environment. */
export type ProviderContext = Pick<RunContext, "settings" | "env" | "prompt">;

/** A provider and the name its calls are recorded under: its settings id. */
export interface NamedProvider {
  provider: GenerationProvider;
  name: string;
}

function options(ctx: ProviderContext, script?: Script) {
  return { ...(ctx.env && { env: ctx.env }), ...(script && { script }) };
}

/** The Vercel AI Gateway provider of the settings (src/providers/adapter.ts). */
export function gatewayProvider(ctx: ProviderContext): NamedProvider {
  const configured = providerOfAdapter(ctx.settings, "vercel-ai-gateway", options(ctx));
  return { provider: configured.provider, name: configured.id };
}

/** The scripted provider of the settings, answering from the module's script. */
export function scriptedProvider(script: Script, ctx: ProviderContext): NamedProvider {
  const configured = providerOfAdapter(ctx.settings, "scripted", options(ctx, script));
  return { provider: configured.provider, name: configured.id };
}

/** The scripted provider of --provider-script when given, else undefined. */
export async function scriptedFrom(
  providerScript: string | undefined,
  ctx: ProviderContext,
): Promise<NamedProvider | undefined> {
  return providerScript ? scriptedProvider(await loadScript(providerScript, ctx), ctx) : undefined;
}

/** The provider of a run: the --provider-script module when given, else the gateway. */
export async function providerFor(
  providerScript: string | undefined,
  ctx: ProviderContext,
): Promise<NamedProvider> {
  return (await scriptedFrom(providerScript, ctx)) ?? gatewayProvider(ctx);
}

/**
 * The billing of the provider a dry run would use, loading (and so checking) --provider-script
 * when given; the gateway's otherwise. Makes no call.
 */
export async function dryRunProvider(
  providerScript: string | undefined,
  ctx: ProviderContext,
): Promise<Billing> {
  return (await providerFor(providerScript, ctx)).provider.billing;
}

/**
 * The real provider of a stage run: 3D characters make their 3D calls on Tripo and their identity
 * calls on the gateway; other kinds use the gateway alone.
 */
export function stageProvider(
  spec: AssetSpec,
  ctx: ProviderContext,
): { provider: GenerationProvider; providerName: string } {
  const gateway = gatewayProvider(ctx);
  if (spec.kind !== CHARACTER_3D_KIND) {
    return { provider: gateway.provider, providerName: gateway.name };
  }
  const tripo = providerOfAdapter(ctx.settings, "tripo", options(ctx));
  return {
    provider: new RoutedProvider({
      gateway: gateway.provider,
      models: tripo.provider,
    }),
    providerName: `${tripo.id}+${gateway.name}`,
  };
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
 * The context of the planning tools (plan, apply, mcp): the scripted provider, else the gateway
 * when its key is set, else no provider.
 */
export async function planningContext(
  providerScript: string | undefined,
  workItem: string | undefined,
  ctx: ProviderContext,
): Promise<ToolContext> {
  const ledger = spendLedger(ctx, workItem);
  const runCapUsd = ctx.settings.caps.runUsd;
  const scripted = await scriptedFrom(providerScript, ctx);
  if (scripted)
    return { provider: scripted.provider, providerName: scripted.name, ledger, runCapUsd };
  const configured = providerOfAdapter(ctx.settings, "vercel-ai-gateway", options(ctx));
  if (configured.keyPresent)
    return { provider: configured.provider, providerName: configured.id, ledger, runCapUsd };
  return { ledger, runCapUsd };
}
