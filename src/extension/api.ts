/**
 * The extension contract (design section 11), published as `@clockgrove/assetgrove/extension`.
 * A package declares `"assetgrove": {"api": 1, "entry": "..."}` in its package.json and
 * peer-depends on `@clockgrove/assetgrove`; core loads it only when the developer settings list it
 * (src/extensions/registry.ts). Its entry's default export is an `Extension`, or a function of the
 * `ExtensionContext` that returns one. Runtime helpers reach an extension through the context,
 * never through imports of core; this module exports only types and `EXTENSION_API`.
 */
import type { z } from "zod";
import type { HandoffPreset } from "../handoff/presets/index.ts";
import type { Generator } from "../generators/generator.ts";
import type { ProviderAdapter } from "../providers/adapter.ts";

/** The extension API version this build of Assetgrove loads. */
export const EXTENSION_API = 1;

/** An asset kind: one spec `kind`, its planned calls and how one candidate is made. */
export type AssetKind = Generator;

/** An engine hand-off preset a target profile's `handoff` list names. */
export type EnginePreset<Options = unknown> = HandoffPreset<Options>;

/** What an extension supplies. Every id is `<name>:<id>`. */
export interface Extension {
  api: typeof EXTENSION_API;
  /** Lower-case letters, digits and hyphens; never `core`. */
  name: string;
  kinds?: AssetKind[];
  presets?: EnginePreset[];
  adapters?: ProviderAdapter[];
}

/** What core hands an entry's default export when it is a function. */
export interface ExtensionContext {
  api: typeof EXTENSION_API;
  /** The zod core validates preset options with. */
  z: typeof z;
}

/** An entry module's default export. */
export type ExtensionEntry =
  Extension | ((context: ExtensionContext) => Extension | Promise<Extension>);

export type { GeneratedCandidate, GeneratorContext, PlannedCall } from "../generators/generator.ts";
export type { PresetContext, PresetFile } from "../handoff/presets/index.ts";
export type { AdapterContext, Capability, ProviderAdapter } from "../providers/adapter.ts";
export type {
  Billing,
  CallKind,
  GenerationProvider,
  ImageInput,
  ImageRequest,
  ImageResult,
  VisionRequest,
  VisionResult,
} from "../gateway/provider.ts";
export type { Route, Routes } from "../routes.ts";
export type { ProviderSettings } from "../settings.ts";
export type { AssetSpec, MediaOutput, QaResult, Reason, TargetProfile } from "../types.ts";
