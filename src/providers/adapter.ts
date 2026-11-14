/**
 * Provider adapters (design sections 3, 4 and 11): each adapter makes provider instances from a
 * `settings.providers` entry and decides their billing. Core passes the key (from `keyEnv` or the
 * adapter's default variable) and the endpoint to every SDK explicitly, so no `*_BASE_URL`
 * variable ever applies. Adapter-aware settings refusals (an unknown adapter, a `baseURL` the
 * adapter does not take) exit 2 `settings_invalid` here, when providers are created.
 */
import type { Env } from "../env.ts";
import { SettingsError } from "../env.ts";
import type { Billing, GenerationProvider } from "../gateway/provider.ts";
import type { ModelProvider } from "../gateway/routed.ts";
import { ScriptedProvider } from "../gateway/scripted.ts";
import type { Script } from "../gateway/scripted.ts";
import { GATEWAY_BASE_URL, VercelGateway } from "../gateway/vercel.ts";
import { TRIPO_BASE_URL, TripoProvider } from "../gateway/tripo.ts";
import type { ProviderSettings, Settings } from "../settings.ts";

export type AdapterCapability =
  "image" | "edit" | "vision" | "decide" | "model" | "rig" | "animate";

export type { ModelProvider } from "../gateway/routed.ts";

export interface CreateOptions {
  providerId: string;
  apiKey?: string;
  baseURL?: string;
  settings: ProviderSettings;
  /** The keyEnv the key was read from, for the error a keyless call gives. */
  keyEnv?: string;
  /** The provider script, for the scripted adapter. */
  script?: Script;
}

export interface ProviderAdapter {
  id: string;
  capabilities: AdapterCapability[];
  defaultKeyEnv?: string;
  fixedHosts: string[];
  /** Whether a settings `baseURL` may replace the fixed endpoint. */
  endpointFromSettings: boolean;
  create(c: CreateOptions): GenerationProvider | ModelProvider;
}

export const GATEWAY_ADAPTER = "vercel-ai-gateway";
export const TRIPO_ADAPTER = "tripo";
export const SCRIPTED_ADAPTER = "scripted";

const host = (url: string) => new URL(url).host;

/** The hosts an instance reaches: the settings endpoint's when it has one, else the fixed ones. */
function hostsOf(adapter: ProviderAdapter, baseURL: string | undefined): string[] {
  return baseURL !== undefined ? [host(baseURL)] : adapter.fixedHosts;
}

function billingOf(
  adapter: ProviderAdapter,
  c: CreateOptions,
  paid: boolean,
): Omit<Billing, "limitReading"> {
  return {
    adapter: adapter.id,
    provider: c.providerId,
    paid,
    hosts: hostsOf(adapter, c.baseURL),
    ...(c.settings.limit !== undefined && { limit: c.settings.limit }),
  };
}

export const gatewayAdapter: ProviderAdapter = {
  id: GATEWAY_ADAPTER,
  capabilities: ["image", "edit", "vision", "decide"],
  defaultKeyEnv: "AI_GATEWAY_API_KEY",
  fixedHosts: [host(GATEWAY_BASE_URL)],
  endpointFromSettings: true,
  create(c) {
    return new VercelGateway({
      ...(c.apiKey !== undefined && { apiKey: c.apiKey }),
      ...(c.baseURL !== undefined && { baseURL: c.baseURL }),
      keyEnv: c.keyEnv ?? "AI_GATEWAY_API_KEY",
      billing: billingOf(gatewayAdapter, c, true),
    });
  },
};

export const tripoAdapter: ProviderAdapter = {
  id: TRIPO_ADAPTER,
  capabilities: ["model", "rig", "animate"],
  defaultKeyEnv: "TRIPO_API_KEY",
  fixedHosts: [host(TRIPO_BASE_URL)],
  endpointFromSettings: false,
  create(c) {
    return new TripoProvider({
      ...(c.apiKey !== undefined && { apiKey: c.apiKey }),
      keyEnv: c.keyEnv ?? "TRIPO_API_KEY",
      ...(c.settings.usdPerCredit !== undefined && { usdPerCredit: c.settings.usdPerCredit }),
      billing: billingOf(tripoAdapter, c, true),
    });
  },
};

export const scriptedAdapter: ProviderAdapter = {
  id: SCRIPTED_ADAPTER,
  capabilities: ["image", "edit", "vision", "decide", "model", "rig", "animate"],
  fixedHosts: [],
  endpointFromSettings: false,
  create(c) {
    if (c.script === undefined) throw new Error("the scripted adapter needs a provider script");
    // Free unless the script says it stands in for a paid provider (tests).
    return new ScriptedProvider(c.script, billingOf(scriptedAdapter, c, c.script.paid === true));
  },
};

/** Every core adapter, by id. Tripo stays in core. */
export const CORE_ADAPTERS: ReadonlyMap<string, ProviderAdapter> = new Map(
  [gatewayAdapter, tripoAdapter, scriptedAdapter].map((a) => [a.id, a]),
);

/** The adapter id of a provider entry: its `adapter`, else its own id. */
export function adapterIdOf(providerId: string, entry: ProviderSettings): string {
  return entry.adapter ?? providerId;
}

/**
 * The adapter of every configured provider, refusing (exit 2 `settings_invalid`) an unknown
 * adapter id or a `baseURL` on an adapter whose endpoint is fixed.
 */
export function checkAdapters(settings: Settings): Map<string, ProviderAdapter> {
  const adapters = new Map<string, ProviderAdapter>();
  for (const [id, entry] of Object.entries(settings.providers)) {
    adapters.set(id, adapterFor(settings, id, entry));
  }
  return adapters;
}

function adapterFor(settings: Settings, id: string, entry: ProviderSettings): ProviderAdapter {
  const adapterId = adapterIdOf(id, entry);
  const adapter = CORE_ADAPTERS.get(adapterId);
  if (adapter === undefined) {
    throw new SettingsError(
      `${settings.path}: providers.${id} names adapter "${adapterId}", which is not one of ${[...CORE_ADAPTERS.keys()].join(", ")}.`,
    );
  }
  if (entry.baseURL !== undefined && !adapter.endpointFromSettings) {
    throw new SettingsError(
      `${settings.path}: providers.${id}.baseURL is not accepted by the ${adapter.id} adapter, whose endpoint is fixed.`,
    );
  }
  return adapter;
}

/**
 * The configured provider id whose adapter is `adapterId`: the first such entry, else the
 * adapter's own id (an entry need not exist for a core adapter).
 */
export function providerIdFor(settings: Settings, adapterId: string): string {
  const entry = Object.entries(settings.providers).find(
    ([id, value]) => adapterIdOf(id, value) === adapterId,
  );
  return entry?.[0] ?? adapterId;
}

/** The variable an entry's key is read from. */
export function keyEnvOf(adapter: ProviderAdapter, entry: ProviderSettings): string | undefined {
  return entry.keyEnv ?? adapter.defaultKeyEnv;
}

/**
 * Creates the provider `providerId` from its settings entry (or none, for a core adapter id):
 * the key from its variable, the endpoint only where the adapter takes one. Every configured
 * entry is checked first, so a bad entry is refused whichever provider a command uses.
 */
export function createProvider(
  settings: Settings,
  providerId: string,
  options: { env?: Env; script?: Script } = {},
): GenerationProvider | ModelProvider {
  checkAdapters(settings);
  const entry = settings.providers[providerId] ?? {};
  const adapter = adapterFor(settings, providerId, entry);
  const keyEnv = keyEnvOf(adapter, entry);
  const env = options.env ?? process.env;
  const apiKey = keyEnv !== undefined ? env[keyEnv] || undefined : undefined;
  return adapter.create({
    providerId,
    settings: entry,
    ...(apiKey !== undefined && { apiKey }),
    ...(keyEnv !== undefined && { keyEnv }),
    ...(entry.baseURL !== undefined && { baseURL: entry.baseURL }),
    ...(options.script !== undefined && { script: options.script }),
  });
}
