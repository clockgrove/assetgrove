/**
 * The pack test kit, published as `@clockgrove/assetgrove/testing` (design section 11): the
 * scripted provider, a temporary project and settings builder, synthetic samples, and the
 * conformance suite a pack runs on its adapters, kinds and presets. Tests only: nothing here is
 * loaded by core's CLI or MCP server.
 */
export { ScriptedProvider } from "../gateway/scripted.ts";
export type { Script } from "../gateway/scripted.ts";
export { scriptedAdapter } from "../providers/adapter.ts";
export { RefusingCaller, CallRefusedError } from "../calls.ts";
export { createExtensionContext as extensionContext } from "../extension/context.ts";
export {
  assertConformance,
  exactCheckProblems,
  resolveEntry,
  runConformance,
} from "./conformance.ts";
export type {
  ConformanceOptions,
  ConformanceReport,
  KindSample,
  PresetSample,
} from "./conformance.ts";
export { SCRIPTED_LIMIT, TEST_OPERATOR, tempProject } from "./project.ts";
export type { CliResult, McpSession, RunOptions, TempProject } from "./project.ts";
export {
  SAMPLE_PALETTE,
  bibleMarkdown,
  sampleBible,
  sampleProfile,
  samplePng,
  sampleScript,
  sampleWav,
} from "./samples.ts";
export type { SampleWavOptions } from "./samples.ts";
export type { ConfirmRequest } from "../confirm/prompt.ts";
export type { Outcome } from "../commands/types.ts";
export { asepriteFile, fernAseprite } from "./aseprite.ts";
export type { AsepriteCelInput, AsepriteInput, AsepriteLayerInput } from "./aseprite.ts";
