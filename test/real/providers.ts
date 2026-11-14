/**
 * The real providers of the opt-in checks, made as a run makes them: by their adapters from the
 * developer settings, each key from its keyEnv or the adapter's default variable.
 */
import { VercelGateway } from "../../src/gateway/vercel.ts";
import { TripoProvider } from "../../src/gateway/tripo.ts";
import {
  GATEWAY_ADAPTER,
  TRIPO_ADAPTER,
  createProvider,
  providerIdFor,
} from "../../src/providers/adapter.ts";
import { loadSettings } from "../../src/settings.ts";

export function realGateway(): VercelGateway {
  const settings = loadSettings();
  return createProvider(settings, providerIdFor(settings, GATEWAY_ADAPTER)) as VercelGateway;
}

export function realTripo(): TripoProvider {
  const settings = loadSettings();
  return createProvider(settings, providerIdFor(settings, TRIPO_ADAPTER)) as TripoProvider;
}
