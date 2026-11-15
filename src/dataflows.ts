/**
 * Where each configured operation's data goes (design section 13): the provider and host its route
 * calls, the model vendor behind a gateway route, and the terms recorded for it. init shows it; the
 * terms are recorded, not a licence.
 */
import type { Env } from "./env.ts";
import { createProviders } from "./providers/adapter.ts";
import { knownOperations, resolveRoute, RouteUnavailableError } from "./routes.ts";
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

/**
 * One entry per operation the settings route (an operation no configured provider serves is left
 * out), in the role table's order. Makes no call and reads no key.
 */
export function routeDataFlows(
  settings: Pick<Settings, "providers" | "roles" | "routes" | "path">,
  options: { env?: Env } = {},
): RouteDataFlow[] {
  const configured = createProviders(settings, { env: options.env ?? {} });
  const flows: RouteDataFlow[] = [];
  for (const operation of knownOperations(settings)) {
    let route;
    try {
      route = resolveRoute(settings, operation, configured);
    } catch (error) {
      if (error instanceof RouteUnavailableError) continue;
      throw error;
    }
    const provider = configured.find((c) => c.id === route.provider)!;
    const host = provider.provider.billing.hosts[0] ?? null;
    const hostname = host === null ? null : new URL(`http://${host}`).hostname;
    const slash = route.model.indexOf("/");
    flows.push({
      operation,
      providerId: provider.id,
      host,
      upstream:
        provider.adapter.id === "vercel-ai-gateway" && slash > 0
          ? route.model.slice(0, slash)
          : null,
      providerTerms: route.providerTerms ?? null,
      retention: hostname === null || isLoopback(hostname) ? "local" : null,
    });
  }
  return flows;
}
