/**
 * Core registers its asset kinds, hand-off presets and provider adapters through the same contract
 * as an extension (design section 11): one `Extension` named `core`, whose ids carry no prefix.
 */
import type { EnginePreset, Extension } from "../extension/api.ts";
import { EXTENSION_API } from "../extension/api.ts";
import { audioGenerators } from "../audio/kinds.ts";
import { imageGenerators } from "../generators/image.ts";
import { asepriteJsonPreset } from "../handoff/presets/aseprite-json.ts";
import { atlasJsonPreset } from "../handoff/presets/atlas-json.ts";
import { manifestPreset } from "../handoff/presets/manifest.ts";
import { character3dGenerator } from "../model3d/generator.ts";
import { CORE_ADAPTERS } from "../providers/adapter.ts";

export const CORE_EXTENSION_NAME = "core";

export const coreExtension: Extension = {
  api: EXTENSION_API,
  name: CORE_EXTENSION_NAME,
  kinds: [...imageGenerators, character3dGenerator, ...audioGenerators],
  presets: [manifestPreset, atlasJsonPreset, asepriteJsonPreset] as EnginePreset[],
  adapters: [...CORE_ADAPTERS],
};
