import { CORE_REGISTRY } from "../extensions/registry.ts";
import { defineCommand } from "./types.ts";

export const extensionsCommand = defineCommand<Record<string, never>>({
  name: "extensions",
  tool: "extensions",
  summary: "list the extensions that loaded, core first, with their kinds, presets and adapters",
  details: `Lists core and every extension the developer settings' extensions list loaded: its name,
package, version, entry file and the asset kinds, hand-off presets and provider adapters it
registered. An extension loads only when the settings list its package, the package resolves from
the project, its declared api matches and the project's Git does not track its entry
(docs/extensions.md). Local: no model call, no spend.`,
  input: { type: "object", properties: {}, additionalProperties: false },
  effect: { readOnly: true, spends: "never", writes: "none" },
  async run(_args, ctx) {
    const loaded = (ctx.extensions ?? CORE_REGISTRY).loaded;
    const lines = loaded.flatMap((e) => [
      `${e.name}  ${e.package}${e.version !== null ? `@${e.version}` : ""}${e.entry !== null ? `  ${e.entry}` : ""}`,
      ...(
        [
          ["kinds", e.kinds],
          ["presets", e.presets],
          ["adapters", e.adapters],
        ] as const
      )
        .filter(([, ids]) => ids.length > 0)
        .map(([what, ids]) => `  ${what}: ${ids.join(", ")}`),
    ]);
    return { exitCode: 0, fields: { extensions: loaded }, human: lines.join("\n") };
  },
});
