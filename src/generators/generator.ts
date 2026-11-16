import type { Caller } from "../calls.ts";
import type { ReferenceViewCache } from "../model3d/views.ts";
import type { Routes } from "../routes.ts";
import type { AssetSpec, MediaOutput, QaResult, StyleBible, TargetProfile } from "../types.ts";

/**
 * A generator turns one asset spec into one candidate: its model calls, post-processing and QA.
 * A new media type is a new generator registered with the loop; the loop itself does not change.
 */
export interface GeneratorContext {
  spec: AssetSpec;
  /** Directory the spec's relative paths (such as `keyPose`) resolve against. */
  specDir: string;
  bible: StyleBible;
  /** Directory the bible's relative paths resolve against. */
  bibleDir: string;
  profile: TargetProfile;
  /** Every provider call goes through this; it reserves against the cap and records provenance. */
  call: Caller;
  /** Zero-based candidate number within the run. */
  index: number;
  /** A per-candidate seed, sent to models whose route supports seeds. */
  seed: number;
  /** The author's note of this round, appended to the generation prompts. */
  note?: string;
  /** Directory the profile's relative paths (a rig template, reference frames) resolve against. */
  profileDir?: string;
  /** The run's cache of which view each reference image shows, shared by its candidates. */
  referenceViews?: ReferenceViewCache;
}

export interface GeneratedCandidate {
  output: MediaOutput;
  qa: QaResult;
  /** The prompt that defines the candidate (for animation, the key-pose prompt). */
  prompt: string;
  parameters: Record<string, unknown>;
  /**
   * Files written for the person beside the candidate, such as a 3D model's turntable renders,
   * whether or not it passes QA. Written to `<run>/c<n>-<generator kind as a slug>/` (`safeSegment`:
   * `ext:tile` writes to `c1-ext-tile/`).
   */
  artifacts?: Array<{ name: string; bytes: Uint8Array }>;
}

/** One model call a candidate makes, as forecast from the routes. */
export interface PlannedCall {
  operation: string;
  model: string;
  estimatedCostUsd: number;
}

export interface Generator {
  /** The `kind` of asset spec this generator handles. */
  kind: string;
  /**
   * The calls one candidate makes, from the routes; their estimates are reserved before the run
   * starts. Throws `InputError` for a spec that cannot be generated, before any spend.
   */
  planCandidate(spec: AssetSpec, profile: TargetProfile, routes: Routes): PlannedCall[];
  /**
   * The calls a request makes once, whatever its candidate count (a 3D character's reference
   * view calls); forecast with the candidates' calls. Absent: none.
   */
  planRequest?(
    spec: AssetSpec,
    profile: TargetProfile,
    routes: Routes,
    bible: StyleBible,
  ): PlannedCall[];
  generate(context: GeneratorContext): Promise<GeneratedCandidate>;
}
