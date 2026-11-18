/**
 * The Godot pack's entry for core's extension API (api 2): the `godot:sprite-frames` preset, the
 * `godot:engine` tool (the executable at its settings' `godot`), and a setup that downloads the
 * pinned Godot or uses the one the settings name.
 */
import type { Extension, ExtensionContext } from "@clockgrove/assetgrove/extension";
import { setupGodot } from "./setup.ts";
import { TOOL, spriteFramesPreset } from "./sprite-frames.ts";

export interface GodotSettings {
  /** The Godot 4.7.2 executable's absolute path. */
  godot?: string | undefined;
}

export default function godotExtension(context: ExtensionContext): Extension {
  return {
    api: context.api,
    name: "godot",
    settingsSchema: context.z.strictObject({ godot: context.z.string().optional() }),
    presets: [spriteFramesPreset(context)],
    tools: [{ id: TOOL, setting: "godot" }],
    setup: async (ctx) => ({
      ...(await setupGodot(ctx, (context.settings ?? {}) as GodotSettings)),
    }),
  };
}
