import type { RunContext } from "../commands/types.ts";
import type { Script } from "../gateway/scripted.ts";
import type { Billing, GenerationProvider } from "../gateway/provider.ts";
import { RoutedProvider } from "../gateway/routed.ts";
import type { ModelProvider } from "../gateway/routed.ts";
import type { ToolContext } from "../mcp.ts";
import { CHARACTER_3D_KIND } from "../model3d/profile.ts";
import { SpendLedger } from "../spend.ts";
import type { AssetSpec } from "../types.ts";
import {
  GATEWAY_ADAPTER,
  SCRIPTED_ADAPTER,
  TRIPO_ADAPTER,
  adapterIdOf,
  checkAdapters,
  createProvider,
  keyEnvOf,
  gatewayAdapter,
  providerIdFor,
} from "./adapter.ts";
import { loadScript } from "./script.ts";

export { loadScript } from "./script.ts";

/** What providers are made from: the developer settings and the environment holding the keys. */
export type ProviderContext = Pick<RunContext, "settings" | "env">;

/** A provider and the settings id its calls are recorded under. */
export interface NamedProvider {
  provider: GenerationProvider;
  name: string;
}

function named(ctx: ProviderContext, adapterId: string, script?: Script): NamedProvider {
  const name = providerIdFor(ctx.settings, adapterId);
  const provider = createProvider(ctx.settings, name, {
    ...(ctx.env !== undefined && { env: ctx.env }),
    ...(script !== undefined && { script }),
  }) as GenerationProvider;
  return { provider, name };
}

/**
 * The gateway from its settings entry (or none): the key from its keyEnv or AI_GATEWAY_API_KEY.
 * Without a key, its first call fails with a provider error (exit 4).
 */
export function gatewayProvider(ctx: ProviderContext): NamedProvider {
  return named(ctx, GATEWAY_ADAPTER);
}

/** The scripted provider of --provider-script, under its settings id; free unless `paid`. */
export function scriptedProvider(ctx: ProviderContext, script: Script): NamedProvider {
  return named(ctx, SCRIPTED_ADAPTER, script);
}

/** The scripted provider of --provider-script when given, else undefined. */
export async function scriptedFrom(
  ctx: ProviderContext,
  providerScript: string | undefined,
): Promise<NamedProvider | undefined> {
  return providerScript ? scriptedProvider(ctx, await loadScript(providerScript)) : undefined;
}

/** The provider of a run: the --provider-script module when given, else the gateway. */
export async function providerFor(
  ctx: ProviderContext,
  providerScript: string | undefined,
): Promise<NamedProvider> {
  return (await scriptedFrom(ctx, providerScript)) ?? gatewayProvider(ctx);
}

/**
 * The real provider of a stage run: 3D characters make their 3D calls on Tripo and their identity
 * calls on the gateway, each billed by its own adapter; other kinds use the gateway alone.
 */
export function stageProvider(
  ctx: ProviderContext,
  spec: AssetSpec,
): { provider: GenerationProvider; providerName: string } {
  const gateway = gatewayProvider(ctx);
  if (spec.kind !== CHARACTER_3D_KIND)
    return { provider: gateway.provider, providerName: gateway.name };
  const tripoId = providerIdFor(ctx.settings, TRIPO_ADAPTER);
  const models = createProvider(ctx.settings, tripoId, {
    ...(ctx.env !== undefined && { env: ctx.env }),
  }) as ModelProvider;
  return {
    provider: new RoutedProvider({ gateway: gateway.provider, models }),
    providerName: `${tripoId}+${gateway.name}`,
  };
}

/**
 * The cross-run spend ledger of this invocation (src/spend.ts): `<stateDir>/spend.jsonl` and the
 * caps from the developer settings, the work item from --work-item or ASSETGROVE_WORK_ITEM.
 */
export function spendLedger(ctx: ProviderContext, workItem: string | undefined): SpendLedger {
  return SpendLedger.fromSettings(ctx.settings, {
    ...(workItem !== undefined && { workItem }),
    ...(ctx.env !== undefined && { env: ctx.env }),
  });
}

/**
 * The context of the planning tools (plan, apply, mcp): the scripted provider, else the gateway
 * when its key variable is set, else no provider.
 */
export async function planningContext(
  ctx: ProviderContext,
  providerScript: string | undefined,
  workItem: string | undefined,
): Promise<ToolContext> {
  const ledger = spendLedger(ctx, workItem);
  const base = { ledger, runCapUsd: ctx.settings.caps.runUsd };
  const scripted = await scriptedFrom(ctx, providerScript);
  if (scripted) return { ...base, provider: scripted.provider, providerName: scripted.name };
  const id = providerIdFor(ctx.settings, GATEWAY_ADAPTER);
  const keyEnv = keyEnvOf(gatewayAdapter, ctx.settings.providers[id] ?? {});
  if (keyEnv !== undefined && (ctx.env ?? process.env)[keyEnv]) {
    const gateway = gatewayProvider(ctx);
    return { ...base, provider: gateway.provider, providerName: gateway.name };
  }
  return base;
}

/**
 * Every configured provider (or only `only`, configured or a core adapter id) as its adapter makes
 * it, for `spend check` and `settings check`: a scripted entry answers from --provider-script when
 * given, else from an empty script, which reads no limit.
 */
export async function configuredProviders(
  ctx: ProviderContext,
  providerScript: string | undefined,
  only?: string,
): Promise<{ id: string; billing: Billing }[]> {
  checkAdapters(ctx.settings);
  const script = providerScript ? await loadScript(providerScript) : undefined;
  const ids = only !== undefined ? [only] : Object.keys(ctx.settings.providers);
  return ids.map((id) => {
    const entry = ctx.settings.providers[id] ?? {};
    const scripted = adapterIdOf(id, entry) === SCRIPTED_ADAPTER;
    const provider = createProvider(ctx.settings, id, {
      ...(ctx.env !== undefined && { env: ctx.env }),
      ...(scripted && { script: script ?? EMPTY_SCRIPT }),
    });
    return { id, billing: provider.billing };
  });
}

const EMPTY_SCRIPT: Script = {
  image: () => {
    throw new Error("no provider script");
  },
  vision: () => {
    throw new Error("no provider script");
  },
};
