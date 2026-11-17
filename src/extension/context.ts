/**
 * The `ExtensionContext` core hands a pack's entry (design section 11): zod, core's raster, QA and
 * prompt helpers, the host-guarded `http`, the current run and a logger.
 */
import { dirname } from "node:path";
import { z } from "zod";
import { currentRunScope } from "../runs/journal.ts";
import { EXTENSION_API } from "./api.ts";
import type { ExtensionContext } from "./api.ts";
import { prompt, qa, raster } from "./helpers.ts";
import { allowedHosts, guardedFetch } from "./http.ts";

/** The context for the pack `name`; `log` writes one line per message to `write` (stderr). */
export function createExtensionContext(
  name: string,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): ExtensionContext {
  return Object.freeze({
    api: EXTENSION_API,
    z,
    raster,
    qa,
    prompt,
    http: (adapter, c) =>
      guardedFetch({ adapter: adapter.id, hosts: allowedHosts(adapter, c?.baseURL) }),
    run: Object.freeze({
      current: () => {
        const scope = currentRunScope();
        if (scope === undefined) return undefined;
        return {
          cleared: scope.clearance !== undefined,
          ...(scope.journal !== undefined && {
            id: scope.journal.runId,
            dir: dirname(scope.journal.dir),
          }),
        };
      },
    }),
    log: (message: string) => write(`[${name}] ${message}`),
  } satisfies ExtensionContext);
}
