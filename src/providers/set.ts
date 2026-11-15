/**
 * The providers of the developer settings and the routes they serve (design section 12). A
 * `ProviderSet` resolves each operation to its route and serves each call on the route's provider;
 * the `Caller` records the call as `<providerId>:<operation>:<model>`.
 */
import type { Env } from "../env.ts";
import { InputError, ProviderError } from "../errors.ts";
import type {
  Billing,
  DecisionRequest,
  DecisionResult,
  GenerationProvider,
  ImageRequest,
  ImageResult,
  VisionRequest,
  VisionResult,
} from "../gateway/provider.ts";
import type { Script } from "../gateway/scripted.ts";
import { resolveRoutes, roleOf, OPERATION_ROLES } from "../routes.ts";
import type { Route, Routes } from "../routes.ts";
import type { Settings } from "../settings.ts";
import { CORE_ADAPTERS, createProviders } from "./adapter.ts";
import type { ConfiguredProvider, ProviderAdapter } from "./adapter.ts";

/** The provider that serves a call, and the id its calls are recorded under. */
export interface ServedBy {
  provider: GenerationProvider;
  id: string;
}

/**
 * Every provider of the settings, made by its adapter, and the routes of the settings. It is a
 * `GenerationProvider` only so commands can hand it where one provider went: its billing is the
 * union of its parts, and its calls go through the `Caller`, which serves each on its route's
 * provider (`serve`).
 */
export class ProviderSet implements GenerationProvider {
  readonly routes: Routes;
  readonly configured: readonly ConfiguredProvider[];
  readonly billing: Billing;
  /**
   * The billing of every provider some route names. Only the billing summary uses it: each call's
   * limit is checked on the provider that serves it (`Caller`), not on every part.
   */
  readonly parts: readonly Billing[];

  /** Whether scripted providers were given a module. */
  readonly #scripted: boolean;
  /** Whether some route names a scripted provider, which the module would serve. */
  readonly #scriptServes: boolean;

  constructor(configured: readonly ConfiguredProvider[], routes: Routes, scripted = false) {
    this.configured = configured;
    this.#scripted = scripted;
    this.routes = routes;
    this.#scriptServes = Object.values(routes).some(
      (r) => configured.find((c) => c.id === r.provider)?.adapter.id === "scripted",
    );
    const used = new Set(Object.values(routes).map((r) => r.provider));
    const parts = configured.filter((c) => used.has(c.id)).map((c) => c.provider.billing);
    this.parts = parts;
    this.billing = {
      adapter: [...new Set(parts.map((b) => b.adapter))].join("+") || "none",
      providerId: parts.map((b) => b.providerId).join("+") || "none",
      paid: parts.some((b) => b.paid),
      hosts: [...new Set(parts.flatMap((b) => b.hosts))],
      reconcile: "unavailable",
    };
  }

  /** The providers and routes of the settings; `script` is given to scripted providers. */
  static fromSettings(
    settings: Pick<Settings, "providers" | "roles" | "routes" | "path">,
    options: { env?: Env; script?: Script; adapters?: readonly ProviderAdapter[] } = {},
  ): ProviderSet {
    const configured = createProviders(settings, options);
    return new ProviderSet(
      configured,
      resolveRoutes(settings, configured),
      options.script !== undefined,
    );
  }

  /** The configured provider of a settings id. */
  get(id: string): ConfiguredProvider | undefined {
    return this.configured.find((c) => c.id === id);
  }

  /** The provider that serves a route. */
  serve(route: Route, operation: string): ServedBy {
    const configured = route.provider !== undefined ? this.get(route.provider) : undefined;
    if (configured === undefined) {
      throw new ProviderError(
        `the ${operation} route names provider "${route.provider ?? "(none)"}", which is not configured`,
      );
    }
    if (this.#scripted && !this.#scriptServes) {
      throw new InputError(
        `--provider-script was given, but no route of the developer settings names a scripted provider, so the script would serve no call and the ${operation} call would go to provider "${configured.id}" (${configured.adapter.id}) for real. Add a provider with "adapter": "scripted" to settings.providers and route roles to it, or leave out --provider-script.`,
      );
    }
    return { provider: configured.provider, id: configured.id };
  }

  /**
   * Whether the route's provider can be called: it has its key or takes none, and a scripted
   * provider has its module.
   */
  callable(route: Route): boolean {
    const configured = route.provider !== undefined ? this.get(route.provider) : undefined;
    if (configured === undefined) return false;
    if (configured.adapter.id === "scripted") return this.#scripted;
    return configured.keyEnv === undefined || configured.keyPresent;
  }

  #direct(): never {
    throw new ProviderError("a provider set serves calls through the Caller, by route");
  }

  generateImage(_request: ImageRequest): Promise<ImageResult> {
    return this.#direct();
  }

  analyzeImages(_request: VisionRequest): Promise<VisionResult> {
    return this.#direct();
  }

  decide(_request: DecisionRequest): Promise<DecisionResult> {
    return this.#direct();
  }
}

/** A role's suggested route: the adapter that would serve it and the model. */
export interface SuggestedRole {
  provider: string;
  model: string;
}

/**
 * The roles init suggests for these adapters: each role served by the first adapter (in the given
 * order) whose default routes include an operation of that role, with that route's model.
 */
export function suggestRoles(
  adapterIds: readonly string[],
  adapters: readonly ProviderAdapter[] = CORE_ADAPTERS,
): Record<string, SuggestedRole> {
  const roles: Record<string, SuggestedRole> = {};
  for (const id of adapterIds) {
    const adapter = adapters.find((a) => a.id === id);
    if (adapter === undefined) continue;
    for (const [operation, route] of Object.entries(adapter.defaultRoutes ?? {})) {
      const role = roleOf(operation);
      if (role === undefined || roles[role] !== undefined) continue;
      // The role's first operation in the table names its model (still for image, edit for edit).
      const first = Object.keys(OPERATION_ROLES).find(
        (op) => OPERATION_ROLES[op] === role && adapter.defaultRoutes?.[op] !== undefined,
      );
      roles[role] = { provider: id, model: (adapter.defaultRoutes?.[first!] ?? route).model };
    }
  }
  return roles;
}
