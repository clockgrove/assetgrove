/**
 * Where each configured operation's data goes (design section 13): the provider and host its route
 * calls, the model vendor behind a gateway route, and the terms recorded for it. init shows it; the
 * terms are recorded, not a licence.
 */
import type { Env } from "./env.ts";
import { createProviders, type ProviderAdapter } from "./providers/adapter.ts";
import {
  knownOperations,
  resolveRoute,
  RouteAmbiguousError,
  RouteUnavailableError,
} from "./routes.ts";
import type { Settings } from "./settings.ts";
import { isLoopback } from "./settings.ts";

export interface RouteDataFlow {
  operation: string;
  providerId: string;
  /** The host its calls reach; null for a provider that reaches none (the scripted one). */
  host: string | null;
  /** The model vendor behind a gateway route (the model id's prefix); null for a direct route. */
  upstream: string | null;
  /** The provider terms recorded for its (provider, model) pair; null when none are. */
  providerTerms: string | null;
  /** `local` when its data stays on this machine; null when no retention is recorded. */
  retention: "local" | null;
}

/** The model vendor behind a gateway route (the model id's prefix); null for a direct route. */
export function upstreamOf(adapterId: string, model: string): string | null {
  const slash = model.indexOf("/");
  return adapterId === "vercel-ai-gateway" && slash > 0 ? model.slice(0, slash) : null;
}

/**
 * One entry per operation the settings route (an operation no configured provider serves, or
 * that several could and none is chosen, is left out), in the role table's order. Makes no call and reads no key.
 */
export function routeDataFlows(
  settings: Pick<Settings, "providers" | "roles" | "routes" | "path">,
  options: {
    env?: Env;
    adapters?: readonly ProviderAdapter[];
    /** Core's operation roles plus the loaded kinds' (`ExtensionRegistry.operations`). */
    operations?: Readonly<Record<string, string>>;
  } = {},
): RouteDataFlow[] {
  const configured = createProviders(settings, {
    env: options.env ?? {},
    ...(options.adapters && { adapters: options.adapters }),
  });
  const flows: RouteDataFlow[] = [];
  for (const operation of knownOperations(settings, options.operations)) {
    let route;
    try {
      route = resolveRoute(settings, operation, configured, options.operations);
    } catch (error) {
      if (error instanceof RouteUnavailableError || error instanceof RouteAmbiguousError) continue;
      throw error;
    }
    const provider = configured.find((c) => c.id === route.provider)!;
    const host = provider.provider.billing.hosts[0] ?? null;
    const hostname = host === null ? null : new URL(`http://${host}`).hostname;
    flows.push({
      operation,
      providerId: provider.id,
      host,
      upstream: upstreamOf(provider.adapter.id, route.model),
      providerTerms: route.providerTerms ?? null,
      retention: hostname === null || isLoopback(hostname) ? "local" : null,
    });
  }
  return flows;
}
