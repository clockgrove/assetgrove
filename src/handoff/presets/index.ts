/**
 * Hand-off presets (design section 14): each writes one form of the hand-off the target reads, and
 * checks what it wrote by reading it back. The profile's `handoff` list names them, by default
 * `[{ preset: "manifest" }]`. Core validates every preset's options before anything is written,
 * writes the media, sidecars and provenance with each preset's files, runs each preset's check, and
 * only then the approved validator. A failed check is `handoff_check_failed` (exit 6).
 */
import type { z } from "zod";
import { InputError } from "../../errors.ts";
import { extensionOf, unavailableId } from "../../extensions/errors.ts";
import type { RegisteredTool } from "../../extensions/registry.ts";
import type { FramesTrait, KindTraits } from "../../frames.ts";
import type { TargetProfile } from "../../types.ts";
import type { ToolRunner } from "../../extension/tools.ts";
import { asepriteJsonPreset } from "./aseprite-json.ts";
import { atlasJsonPreset } from "./atlas-json.ts";
import { manifestPreset } from "./manifest.ts";

/** What a preset reads: the template context and the rendered paths of the hand-off. */
export interface PresetContext {
  profile: TargetProfile;
  /** The values the profile's templates read (`spec`, `profile`, `output`, `provenance`, `run`...). */
  context: Record<string, unknown>;
  /** The rendered `layout.manifest`, relative to the target directory. */
  manifestRel: string;
  /** The `frames` trait the hand-off's kind declares; absent when it declares none. */
  frames?: FramesTrait;
  /**
   * The bytes of this hand-off's media as core writes them (at `output.path`), which the preset
   * cannot `read` yet: core writes the media with the presets' files. Core always sets it;
   * optional so a hand-made context compiles.
   */
  mediaBytes?: Uint8Array;
  /**
   * Runs one of the preset's own pack's declared tools in scratch, under core's approval rules
   * (src/extension/tools.ts). Core always sets it; optional so a hand-made context compiles.
   */
  run?: ToolRunner;
}

/** One file a preset writes, relative to the target directory. */
export interface PresetFile {
  path: string;
  content: Uint8Array | string;
}

/**
 * Reads a file in the target by its path relative to the target: its bytes, or undefined when it
 * is missing. A path core's target-path rule refuses (outside the target, through a link out of it,
 * in `.git`, in the settings or state, a file the validator names) is refused (exit 2).
 */
export type TargetRead = (path: string) => Promise<Uint8Array | undefined>;

/** One animation family of an asset that has been handed off (a family scope preset's input). */
export interface HandedOffFamily {
  /** The animation family. */
  name: string;
  /** Its library id, `<assetId>-<family>`. */
  id: string;
  /** Its media, relative to the target, with `/`. */
  media: string;
  /** The sha256 of its current media. */
  sha256: string;
  /**
   * The bytes of its current media: this hand-off's own for its families. Core always sets it;
   * optional so a hand-made context compiles.
   */
  content?: Uint8Array;
}

/** What a `scope: "families"` preset reads: every family handed off for one asset so far. */
export interface FamiliesContext {
  profile: TargetProfile;
  /** The spec's `assetId` the families share. */
  assetId: string;
  /** The library's families of the asset with this hand-off's in place of their own, by name. */
  families: HandedOffFamily[];
  /** As `PresetContext.run`. */
  run?: ToolRunner;
}

interface PresetShape<Options, Context> {
  name: string;
  /** Validates the profile entry's `options`; anything it refuses is invalid input (exit 2). */
  optionsSchema: z.ZodType<Options>;
  /**
   * The files this preset writes. `read` reads the target as it is before this hand-off writes.
   * Core writes the files, after checking every path.
   */
  write(ctx: Context, options: Options, read: TargetRead): Promise<PresetFile[]>;
  /**
   * Reads back what was written and returns its problems; empty when it holds. `read` reads a
   * written file by its relative path, or undefined when it is missing.
   */
  check(ctx: Context, options: Options, files: PresetFile[], read: TargetRead): Promise<string[]>;
}

/** A preset that writes for one hand-off: one asset, or one family of it. */
export interface AssetPreset<Options = unknown> extends PresetShape<Options, PresetContext> {
  scope?: undefined;
}

/**
 * A preset that writes for every family handed off for an asset so far, read from the library,
 * not only the families of this run: rewriting one family keeps the others in its files.
 */
export interface FamiliesPreset<Options = unknown> extends PresetShape<Options, FamiliesContext> {
  scope: "families";
}

export type HandoffPreset<Options = unknown> = AssetPreset<Options> | FamiliesPreset<Options>;

/** Core's presets by name; the registry (src/extensions/registry.ts) adds the extensions'. */
export const PRESETS: ReadonlyMap<string, HandoffPreset> = new Map<string, HandoffPreset>(
  ([manifestPreset, atlasJsonPreset, asepriteJsonPreset] as HandoffPreset[]).map((preset) => [
    preset.name,
    preset,
  ]),
);

/** The hand-off a profile declares when it names none. */
export const DEFAULT_HANDOFF = [{ preset: "manifest" }] as const;

/** One preset of the profile's list with its validated options. */
export interface ResolvedPreset {
  preset: HandoffPreset;
  options: unknown;
}

/** The presets a profile chooses among, and the settings file that lists their extensions. */
export interface PresetRegistry {
  presets: ReadonlyMap<string, HandoffPreset>;
  settingsPath?: string | undefined;
  /** Every operation with its role, core's and the loaded kinds' (`ExtensionRegistry.operations`). */
  operations?: Readonly<Record<string, string>>;
  /** The loaded kinds with their declared `frames` trait. */
  kinds?: KindTraits["kinds"];
  /** Every tool the loaded packs declare (`ExtensionRegistry.tools`); none when absent. */
  tools?: ReadonlyMap<string, RegisteredTool>;
}

/**
 * The profile's `handoff` list, each entry's preset found in the registry (core's presets when
 * none is given) and its options validated against the preset's `optionsSchema`. Throws an
 * InputError (exit 2) naming what is wrong; an `<ext>:<name>` preset no loaded extension provides
 * is `extension_unavailable`.
 */
export function resolveHandoff(
  profile: TargetProfile,
  registry: PresetRegistry = { presets: PRESETS },
): ResolvedPreset[] {
  const known = registry.presets;
  const list: unknown = profile.handoff ?? DEFAULT_HANDOFF;
  if (!Array.isArray(list) || list.length === 0) {
    throw new InputError("the profile's handoff must list at least one preset");
  }
  return list.map((entry: unknown, i) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new InputError(`handoff[${i}] must be an object with a preset`);
    }
    const { preset: name, options, ...rest } = entry as Record<string, unknown>;
    const extra = Object.keys(rest);
    if (extra.length > 0) {
      throw new InputError(`handoff[${i}] has unknown field(s) ${extra.join(", ")}`);
    }
    const preset = typeof name === "string" ? known.get(name) : undefined;
    if (!preset) {
      if (typeof name === "string" && extensionOf(name) !== undefined)
        throw unavailableId(name, `handoff[${i}].preset`, registry.settingsPath);
      throw new InputError(
        `handoff[${i}].preset ${JSON.stringify(name)} is not a preset (known: ${[...known.keys()].join(", ")})`,
      );
    }
    const parsed = preset.optionsSchema.safeParse(options ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      });
      throw new InputError(
        `handoff[${i}] options for preset "${preset.name}" are invalid: ${issues.join("; ")}`,
        { cause: parsed.error },
      );
    }
    return { preset, options: parsed.data };
  });
}

/** One problem a preset's check found. */
export interface HandoffProblem {
  preset: string;
  problem: string;
  /** The written file the problem is in, relative to the target, when it is one file's. */
  file?: string;
  /** What is wrong with that file: `mark_missing`, `credentials_missing`, `credentials_invalid` or `credentials_mismatch`. */
  code?: string;
}

/** A preset's check found problems in what was written; the validator did not run. Exit 6. */
export class HandoffCheckError extends Error {
  readonly code = "handoff_check_failed";
  readonly problems: HandoffProblem[];
  constructor(problems: HandoffProblem[]) {
    super(
      `the hand-off check failed: ${problems.map((p) => `${p.preset}: ${p.problem}`).join("; ")}`,
    );
    this.name = "HandoffCheckError";
    this.problems = problems;
  }
}
