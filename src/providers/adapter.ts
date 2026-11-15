/**
 * Provider adapters (design section 11): each makes provider instances from a settings entry and
 * decides what they cost (`billing`). Core registers `vercel-ai-gateway`, `anthropic`, `openai`,
 * `openai-compatible`, `tripo` and `scripted`. Each lists the operations it serves by default
 * (`defaultRoutes`, src/routes.ts).
 * An adapter reads its key from the entry's `keyEnv` or its default variable and passes `apiKey`
 * and `baseURL` to its SDK explicitly, so no `*_BASE_URL` variable ever applies.
 */
import type { Env } from "../env.ts";
import { SettingsError } from "../env.ts";
import {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_DEFAULT_ROUTES,
  AnthropicProvider,
} from "../gateway/anthropic.ts";
import { OPENAI_BASE_URL, OPENAI_DEFAULT_ROUTES, OpenAIProvider } from "../gateway/openai.ts";
import type { Billing, GenerationProvider } from "../gateway/provider.ts";
import { OpenAICompatibleProvider } from "../gateway/openai-compatible.ts";
import { ScriptedProvider } from "../gateway/scripted.ts";
import type { Script } from "../gateway/scripted.ts";
import { TRIPO_BASE_URL, TripoProvider } from "../gateway/tripo.ts";
import { VercelGateway } from "../gateway/vercel.ts";
import { defaultRoutes, GATEWAY_DEFAULT_ROUTES, TRIPO_DEFAULT_ROUTES } from "../routes.ts";
import type { Route } from "../routes.ts";
import type { ProviderSettings, Settings } from "../settings.ts";

export type Capability = "image" | "edit" | "vision" | "decide" | "model" | "rig" | "animate";

/** What an adapter is given to make one provider instance. */
export interface AdapterContext {
  providerId: string;
  apiKey?: string;
  /** The variable the key is read from, named in errors when it is unset. */
  keyEnv?: string;
  baseURL?: string;
  settings: ProviderSettings;
  /** The scripted adapter's module (`--provider-script`); other adapters ignore it. */
  script?: Script;
}

export interface ProviderAdapter {
  id: string;
  capabilities: Capability[];
  /** The variable the key is read from when settings name no `keyEnv`. */
  defaultKeyEnv?: string;
  /** The hosts the adapter reaches when settings name no endpoint. */
  fixedHosts: string[];
  /** Whether settings may set `baseURL`. */
  endpointFromSettings: boolean;
  /**
   * The routes it serves when the settings name no route or role for an operation, each with the
   * grant and terms of its (provider, model) pair. None means it serves only what settings route.
   */
  defaultRoutes?: Readonly<Record<string, Route>>;
  create(c: AdapterContext): GenerationProvider;
}

/** The parts of a provider's billing an adapter takes from settings. */
function billingFrom(c: AdapterContext): Pick<Billing, "providerId" | "limit"> {
  return {
    providerId: c.providerId,
    ...(c.settings.limit !== undefined && { limit: c.settings.limit }),
  };
}

export const gatewayAdapter: ProviderAdapter = {
  id: "vercel-ai-gateway",
  capabilities: ["image", "edit", "vision", "decide"],
  defaultKeyEnv: "AI_GATEWAY_API_KEY",
  fixedHosts: [new URL(VercelGateway.defaultBaseURL).host],
  endpointFromSettings: true,
  defaultRoutes: GATEWAY_DEFAULT_ROUTES,
  create: (c) =>
    new VercelGateway({
      apiKey: c.apiKey,
      ...(c.keyEnv !== undefined && { keyEnv: c.keyEnv }),
      ...(c.baseURL !== undefined && { baseURL: c.baseURL }),
      billing: {
        adapter: "vercel-ai-gateway",
        paid: true,
        reconcile: "per-call-cost",
        ...billingFrom(c),
      },
    }),
};

/**
 * Anthropic, direct: vision, decisions (structured output) and planning. Paid; its limit is
 * declared only (an ordinary key cannot read it) and its spend is not reconciled.
 */
export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  capabilities: ["vision", "decide"],
  defaultKeyEnv: "ANTHROPIC_API_KEY",
  fixedHosts: [new URL(ANTHROPIC_BASE_URL).host],
  endpointFromSettings: false,
  defaultRoutes: ANTHROPIC_DEFAULT_ROUTES,
  create: (c) =>
    new AnthropicProvider({
      apiKey: c.apiKey,
      ...(c.keyEnv !== undefined && { keyEnv: c.keyEnv }),
      billing: { adapter: "anthropic", paid: true, reconcile: "unavailable", ...billingFrom(c) },
    }),
};

/**
 * OpenAI, direct: every 2D role, decisions through structured output. Paid; its limit is declared
 * only and its spend is not reconciled.
 */
export const openaiAdapter: ProviderAdapter = {
  id: "openai",
  capabilities: ["image", "edit", "vision", "decide"],
  defaultKeyEnv: "OPENAI_API_KEY",
  fixedHosts: [new URL(OPENAI_BASE_URL).host],
  endpointFromSettings: false,
  defaultRoutes: OPENAI_DEFAULT_ROUTES,
  create: (c) =>
    new OpenAIProvider({
      apiKey: c.apiKey,
      ...(c.keyEnv !== undefined && { keyEnv: c.keyEnv }),
      billing: { adapter: "openai", paid: true, reconcile: "unavailable", ...billingFrom(c) },
    }),
};

export const tripoAdapter: ProviderAdapter = {
  id: "tripo",
  capabilities: ["model", "rig", "animate"],
  defaultKeyEnv: "TRIPO_API_KEY",
  fixedHosts: [new URL(TRIPO_BASE_URL).host],
  endpointFromSettings: false,
  defaultRoutes: TRIPO_DEFAULT_ROUTES,
  create: (c) =>
    new TripoProvider({
      apiKey: c.apiKey,
      ...(c.keyEnv !== undefined && { keyEnv: c.keyEnv }),
      ...(c.settings.usdPerCredit !== undefined && { usdPerCredit: c.settings.usdPerCredit }),
      billing: {
        adapter: "tripo",
        paid: true,
        reconcile: "balance-delta",
        ...billingFrom(c),
      },
    }),
};

/**
 * Any OpenAI-compatible endpoint at the settings' `baseURL` (a loopback image or chat server, or a
 * hosted one). It serves what the server offers, so it has no default routes: settings route each
 * operation to it, with the grant the server's terms give. Paid unless the entry is `free` (a
 * loopback endpoint only); the key, when the server takes one, comes from `keyEnv`.
 */
export const openaiCompatibleAdapter: ProviderAdapter = {
  id: "openai-compatible",
  capabilities: ["image", "edit", "vision", "decide"],
  fixedHosts: [],
  endpointFromSettings: true,
  create: (c) => {
    if (c.baseURL === undefined) {
      throw new SettingsError(
        `providers.${c.providerId} uses the openai-compatible adapter, which needs a baseURL.`,
      );
    }
    return new OpenAICompatibleProvider({
      baseURL: c.baseURL,
      ...(c.apiKey !== undefined && { apiKey: c.apiKey }),
      billing: {
        adapter: "openai-compatible",
        paid: c.settings.free !== true,
        reconcile: "unavailable",
        ...billingFrom(c),
      },
    });
  },
};

/** Answers nothing: the scripted provider before a `--provider-script` module is given. */
const NO_SCRIPT: Script = {
  image: () => {
    throw new Error("the scripted provider has no --provider-script module");
  },
  vision: () => {
    throw new Error("the scripted provider has no --provider-script module");
  },
};

export const scriptedAdapter: ProviderAdapter = {
  id: "scripted",
  capabilities: ["image", "edit", "vision", "decide", "model", "rig", "animate"],
  fixedHosts: [],
  endpointFromSettings: false,
  defaultRoutes,
  create: (c) =>
    new ScriptedProvider(c.script ?? NO_SCRIPT, {
      reconcile: "unavailable",
      ...billingFrom(c),
    }),
};

/** The core adapters, by id. */
export const CORE_ADAPTERS: readonly ProviderAdapter[] = [
  gatewayAdapter,
  anthropicAdapter,
  openaiAdapter,
  openaiCompatibleAdapter,
  tripoAdapter,
  scriptedAdapter,
];

/** A provider entry of the settings, resolved to its adapter, with its instance. */
export interface ConfiguredProvider {
  id: string;
  adapter: ProviderAdapter;
  settings: ProviderSettings;
  /** The variable its key is read from, when the adapter takes a key. */
  keyEnv?: string;
  keyPresent: boolean;
  provider: GenerationProvider;
}

/** The adapter a settings entry names: its `adapter` field, else its id. */
export function adapterOf(
  id: string,
  entry: ProviderSettings,
  adapters: readonly ProviderAdapter[] = CORE_ADAPTERS,
): ProviderAdapter | undefined {
  const name = entry.adapter ?? id;
  return adapters.find((a) => a.id === name);
}

/**
 * Makes one provider from a settings entry. Throws `SettingsError` (exit 2 `settings_invalid`)
 * for an unknown adapter, or a `baseURL` on an adapter whose endpoint is fixed. A missing key is
 * not refused here: the provider's calls fail with a provider error naming the variable.
 */
export function createProvider(
  id: string,
  entry: ProviderSettings,
  options: {
    env?: Env;
    script?: Script;
    path?: string;
    adapters?: readonly ProviderAdapter[];
  } = {},
): ConfiguredProvider {
  const adapters = options.adapters ?? CORE_ADAPTERS;
  const where = options.path !== undefined ? `${options.path}: ` : "";
  const adapter = adapterOf(id, entry, adapters);
  if (adapter === undefined) {
    throw new SettingsError(
      `${where}providers.${id} names adapter "${entry.adapter ?? id}", which is not a known adapter (${adapters.map((a) => a.id).join(", ")}).`,
    );
  }
  if (entry.baseURL !== undefined && !adapter.endpointFromSettings) {
    throw new SettingsError(
      `${where}providers.${id}.baseURL is not accepted: the ${adapter.id} adapter's endpoint is fixed (${adapter.fixedHosts.join(", ") || "none"}).`,
    );
  }
  const env = options.env ?? process.env;
  const keyEnv = entry.keyEnv ?? adapter.defaultKeyEnv;
  const apiKey = keyEnv !== undefined ? env[keyEnv] || undefined : undefined;
  const provider = adapter.create({
    providerId: id,
    settings: entry,
    ...(apiKey !== undefined && { apiKey }),
    ...(keyEnv !== undefined && { keyEnv }),
    ...(entry.baseURL !== undefined && { baseURL: entry.baseURL }),
    ...(options.script !== undefined && { script: options.script }),
  });
  return {
    id,
    adapter,
    settings: entry,
    ...(keyEnv !== undefined && { keyEnv }),
    keyPresent: apiKey !== undefined,
    provider,
  };
}

/** Every provider of the settings, in id order, each made by its adapter. */
export function createProviders(
  settings: Pick<Settings, "providers" | "path">,
  options: { env?: Env; script?: Script } = {},
): ConfiguredProvider[] {
  return Object.keys(settings.providers)
    .sort()
    .map((id) => createProvider(id, settings.providers[id]!, { ...options, path: settings.path }));
}

/**
 * One adapter's provider, for `spend check` with a provider script and no scripted entry: the
 * entry whose id is the adapter's id, else the first entry (by id) of that adapter, else an
 * instance of the adapter with no settings, under the adapter's id, with no declared limit. Calls
 * are never routed through it; routes come from settings (src/providers/set.ts).
 */
export function providerOfAdapter(
  settings: Pick<Settings, "providers" | "path">,
  adapterId: string,
  options: { env?: Env; script?: Script } = {},
): ConfiguredProvider {
  const own = settings.providers[adapterId];
  if (own !== undefined && adapterOf(adapterId, own)?.id === adapterId)
    return createProvider(adapterId, own, { ...options, path: settings.path });
  const id = Object.keys(settings.providers)
    .sort()
    .find((key) => adapterOf(key, settings.providers[key]!)?.id === adapterId);
  if (id !== undefined)
    return createProvider(id, settings.providers[id]!, { ...options, path: settings.path });
  return createProvider(adapterId, { adapter: adapterId }, options);
}
