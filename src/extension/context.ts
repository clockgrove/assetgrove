/**
 * The `ExtensionContext` core hands a pack's entry (design section 11): zod, core's raster, QA and
 * prompt helpers, the host-guarded `http`, the current run, a logger and the pack's settings.
 */
import { dirname } from "node:path";
import { z } from "zod";
import { currentRunScope } from "../runs/journal.ts";
import { EXTENSION_API } from "./api.ts";
import type { ExtensionContext } from "./api.ts";
import { prompt, qa, raster } from "./helpers.ts";
import { allowedHosts, guardedFetch } from "./http.ts";

/** Each context's settings slot, filled once core has validated the pack's block. */
const SETTINGS = new WeakMap<ExtensionContext, { value?: Readonly<Record<string, unknown>> }>();

/** Fills `context.settings` with the pack's validated settings (src/extensions/registry.ts). */
export function bindExtensionSettings(
  context: ExtensionContext,
  settings: Record<string, unknown>,
): void {
  const slot = SETTINGS.get(context);
  if (slot === undefined) throw new Error("not a context core made");
  slot.value = Object.freeze({ ...settings });
}

/**
 * The context for the pack `name`; `log` writes one line per message to `write` (stderr). With
 * `settings` (the test kit's), `context.settings` holds them from the start; otherwise core fills
 * it after the pack's block passes its schema.
 */
export function createExtensionContext(
  name: string,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  settings?: Record<string, unknown>,
): ExtensionContext {
  const slot: { value?: Readonly<Record<string, unknown>> } = {};
  const context = Object.freeze({
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
    get settings(): Readonly<Record<string, unknown>> {
      if (slot.value === undefined)
        throw new Error(
          `the settings of ${name} are handed over once core has checked them against its settingsSchema, after the entry returns: read context.settings when a kind, preset or adapter runs, not in the entry's factory`,
        );
      return slot.value;
    },
  } satisfies ExtensionContext);
  SETTINGS.set(context, slot);
  if (settings !== undefined) bindExtensionSettings(context, settings);
  return context;
}
