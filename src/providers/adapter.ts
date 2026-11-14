/**
 * Provider adapters (design sections 3, 4 and 11). Each adapter turns one settings provider entry
 * into a provider instance that carries its `billing`: whether its calls are paid, the hosts they
 * reach, the declared limit and how to read the provider's balance. The adapter decides; the
 * provider's name never does. Core passes the key and base URL to every SDK explicitly, so no
 * `*_BASE_URL` variable applies.
 */
import { SettingsError } from "../env.ts";
import type { Env } from "../env.ts";
import type { Billing, GenerationProvider } from "../gateway/provider.ts";
import { ScriptedProvider } from "../gateway/scripted.ts";
import type { Script } from "../gateway/scripted.ts";
import { TRIPO_BASE_URL, TRIPO_KEY_ENV, TripoProvider } from "../gateway/tripo.ts";
import { GATEWAY_BASE_URL, GATEWAY_KEY_ENV, VercelGateway } from "../gateway/vercel.ts";
import type { ProviderSettings, Settings } from "../settings.ts";

export type Capability = "image" | "edit" | "vision" | "decide" | "model" | "rig" | "animate";

/** A provider instance as an adapter creates it: always with its billing. */
export type BilledProvider = GenerationProvider & { readonly billing: Billing };

export interface AdapterInput {
  providerId: string;
  apiKey?: string;
  baseURL?: string;
  settings: ProviderSettings;
  /** The `--provider-script` module, for the scripted adapter. */
  script?: Script;
}

export interface ProviderAdapter {
  id: string;
  capabilities: Capability[];
  /** The key variable read when the entry names no `keyEnv`. */
  defaultKeyEnv?: string;
  /** The hosts the adapter reaches when settings give no `baseURL`. */
  fixedHosts: string[];
  /** Whether a settings `baseURL` is accepted; refused (`settings_invalid`) otherwise. */
  endpointFromSettings: boolean;
  create(input: AdapterInput): BilledProvider;
}

const hostOf = (url: string) => new URL(url).host;

function billingOf(input: AdapterInput): Partial<Pick<Billing, "provider" | "limit">> {
  return {
    provider: input.providerId,
    ...(input.settings.limit !== undefined && { limit: input.settings.limit }),
  };
}

export const gatewayAdapter: ProviderAdapter = {
  id: "vercel-ai-gateway",
  capabilities: ["image", "edit", "vision", "decide"],
  defaultKeyEnv: GATEWAY_KEY_ENV,
  fixedHosts: [hostOf(GATEWAY_BASE_URL)],
  endpointFromSettings: true,
  create: (input) =>
    new VercelGateway({
      apiKey: input.apiKey,
      baseURL: input.baseURL,
      keyEnv: input.settings.keyEnv ?? GATEWAY_KEY_ENV,
      billing: billingOf(input),
    }),
};

export const tripoAdapter: ProviderAdapter = {
  id: "tripo",
  capabilities: ["model", "rig", "animate"],
  defaultKeyEnv: TRIPO_KEY_ENV,
  fixedHosts: [hostOf(TRIPO_BASE_URL)],
  endpointFromSettings: false,
  create: (input) =>
    new TripoProvider({
      apiKey: input.apiKey,
      keyEnv: input.settings.keyEnv ?? TRIPO_KEY_ENV,
      usdPerCredit: input.settings.usdPerCredit,
      billing: billingOf(input),
    }),
};

/** No script: every call says so. */
const NO_SCRIPT: Script = {
  image: () => {
    throw new Error("the scripted provider needs --provider-script");
  },
  vision: () => {
    throw new Error("the scripted provider needs --provider-script");
  },
};

export const scriptedAdapter: ProviderAdapter = {
  id: "scripted",
  capabilities: ["image", "edit", "vision", "decide", "model", "rig", "animate"],
  fixedHosts: [],
  endpointFromSettings: false,
  create: (input) => new ScriptedProvider(input.script ?? NO_SCRIPT, billingOf(input)),
};

/** The core adapters, by id. */
export const CORE_ADAPTERS: ReadonlyMap<string, ProviderAdapter> = new Map(
  [gatewayAdapter, tripoAdapter, scriptedAdapter].map((a) => [a.id, a]),
);

/** The adapter of a settings provider entry: its `adapter`, else its id. */
export function adapterOf(settings: Settings, providerId: string): ProviderAdapter {
  const entry = settings.providers[providerId] ?? {};
  const id = entry.adapter ?? providerId;
  const adapter = CORE_ADAPTERS.get(id);
  if (adapter === undefined) {
    throw new SettingsError(
      `${settings.path}: providers.${providerId} names adapter "${id}", which is not one of ${[...CORE_ADAPTERS.keys()].join(", ")}.`,
    );
  }
  if (entry.baseURL !== undefined && !adapter.endpointFromSettings) {
    throw new SettingsError(
      `${settings.path}: providers.${providerId}.baseURL is set, but the ${adapter.id} adapter takes no baseURL; it reaches only ${adapter.fixedHosts.join(", ") || "no host"}.`,
    );
  }
  return adapter;
}

/** The key variable a provider reads: its `keyEnv`, else its adapter's default. */
export function keyEnvOf(settings: Settings, providerId: string): string | undefined {
  return settings.providers[providerId]?.keyEnv ?? adapterOf(settings, providerId).defaultKeyEnv;
}

/** Creates one provider from its settings entry (or, for a core adapter id, from none). */
export function createProvider(
  settings: Settings,
  providerId: string,
  env: Env = process.env,
  script?: Script,
): BilledProvider {
  const adapter = adapterOf(settings, providerId);
  const entry = settings.providers[providerId] ?? {};
  const keyEnv = entry.keyEnv ?? adapter.defaultKeyEnv;
  const apiKey = keyEnv !== undefined ? env[keyEnv] || undefined : undefined;
  return adapter.create({
    providerId,
    settings: entry,
    ...(apiKey !== undefined && { apiKey }),
    ...(entry.baseURL !== undefined && { baseURL: entry.baseURL }),
    ...(script !== undefined && { script }),
  });
}

/** The providers of the settings, created once per process; refusals are `settings_invalid`. */
export class ProviderSet {
  readonly settings: Settings;
  readonly env: Env;
  readonly providers: ReadonlyMap<string, BilledProvider>;

  constructor(settings: Settings, env: Env = process.env) {
    this.settings = settings;
    this.env = env;
    const providers = new Map<string, BilledProvider>();
    for (const id of Object.keys(settings.providers))
      providers.set(id, createProvider(settings, id, env));
    this.providers = providers;
  }

  /** The id of the first configured provider with this adapter, else the adapter's own id. */
  idFor(adapterId: string): string {
    for (const id of this.providers.keys())
      if (adapterOf(this.settings, id).id === adapterId) return id;
    return adapterId;
  }

  /** The first configured provider with this adapter, else the core adapter under its own id. */
  byAdapter(adapterId: string): { id: string; provider: BilledProvider } {
    const id = this.idFor(adapterId);
    return { id, provider: this.providers.get(id) ?? createProvider(this.settings, id, this.env) };
  }

  /** The scripted provider answering from `script`. */
  scripted(script: Script): { id: string; provider: BilledProvider } {
    const id = this.idFor(scriptedAdapter.id);
    return { id, provider: createProvider(this.settings, id, this.env, script) };
  }
}
