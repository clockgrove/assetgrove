import { CORE_REGISTRY } from "../extensions/registry.ts";
import { InputError } from "../errors.ts";
import { setupContext } from "../extension/setup.ts";
import { calling, searchSettings } from "./search.ts";
import { defineCommand } from "./types.ts";

export const extensionsCommand = defineCommand<Record<string, never>>({
  name: "extensions",
  tool: "extensions",
  summary: "list the extensions that loaded, core first, with their kinds, presets and adapters",
  details: `Lists core and every extension the developer settings' extensions list loaded: its name,
package, version, entry file and the asset kinds, hand-off presets and provider adapters it
registered, the tools it declares and whether it has a setup. An extension loads only when the
settings list its package, the package resolves from the project, its declared api matches and the
project's Git does not track its entry (docs/extensions.md). Local: no model call, no spend.`,
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
          ["tools", e.tools ?? []],
        ] as const
      )
        .filter(([, ids]) => ids.length > 0)
        .map(([what, ids]) => `  ${what}: ${ids.join(", ")}`),
      ...(e.setup ? [`  setup: assetgrove extensions setup ${e.name}`] : []),
    ]);
    return { exitCode: 0, fields: { extensions: loaded }, human: lines.join("\n") };
  },
});

export const extensionsSetupCommand = defineCommand<{ name: string }>({
  name: "extensions setup",
  tool: "extensions_setup",
  summary: "run a loaded extension's setup, such as the search model download",
  details: `Runs the setup of the loaded extension <name> (see assetgrove extensions): the files it
downloads are each pinned to a version and a sha256 the extension ships, checked before the file
is used, and land under <stateDir>/models; a mismatch deletes the file and exits 4. An extension
that declares no setup exits 2. Free; writes only under the state directory.`,
  input: {
    type: "object",
    properties: {
      name: { type: "string", description: "the extension's name", placeholder: "<name>" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  positionals: [{ name: "name" }],
  effect: { readOnly: false, spends: "never", writes: "state" },
  async run(args, ctx) {
    const loaded = (ctx.extensions ?? CORE_REGISTRY).extensions;
    const found = loaded.get(args.name);
    if (found === undefined)
      throw new InputError(
        `no loaded extension is named "${args.name}"; loaded: ${[...loaded.keys()].join(", ")}`,
      );
    const setup = found.extension.setup;
    if (setup === undefined) throw new InputError(`extension "${args.name}" declares no setup`);
    // A pack's own error code is mapped as a search slot's is: a code core's table lacks is exit 2.
    const result = await calling(() =>
      setup.call(
        found.extension,
        setupContext({
          stateDir: ctx.settings.stateDir,
          search: searchSettings(ctx.settings),
          name: args.name,
          log: ctx.log,
        }),
      ),
    );
    const fields = { extension: args.name, ...(result as Record<string, unknown> | undefined) };
    return { exitCode: 0, fields, human: JSON.stringify(fields, null, 2) };
  },
});
