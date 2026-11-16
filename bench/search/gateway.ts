/** The AI Gateway endpoint and key the bench's paid commands use, read as core reads them. */
import { adapterOf } from "../../src/providers/adapter.ts";
import { loadSettings } from "../../src/settings.ts";

/**
 * The gateway entry of the developer settings, as core's gateway adapter reads it: the first
 * provider entry (by id) of the `vercel-ai-gateway` adapter gives `baseURL` (the full base URL, path
 * included) and `keyEnv`; with no such entry, the gateway's fixed endpoint and `AI_GATEWAY_API_KEY`.
 */
export function gatewaySettings(): { baseURL?: string; keyEnv: string } {
  const settings = loadSettings();
  const id = Object.keys(settings.providers)
    .sort()
    .find((key) => adapterOf(key, settings.providers[key]!)?.id === "vercel-ai-gateway");
  const entry = id !== undefined ? settings.providers[id]! : undefined;
  return {
    ...(entry?.baseURL !== undefined && { baseURL: entry.baseURL }),
    keyEnv: entry?.keyEnv ?? "AI_GATEWAY_API_KEY",
  };
}
