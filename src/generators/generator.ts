import type { ZodType } from "zod";
import type { Caller } from "../calls.ts";
import type { CallParameters } from "../call-parameters.ts";
import type { ReferenceViewCache } from "../model3d/views.ts";
import type { ClipMapCache } from "../model3d/clip-map.ts";
import type { FramesTrait } from "../frames.ts";
import type { StabilityEntry } from "../qa/stability.ts";
import type { Routes } from "../routes.ts";
import type {
  AssetSpec,
  MediaOutput,
  QaResult,
  Reason,
  StyleBible,
  TargetProfile,
} from "../types.ts";

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
  /** The run's cache of clip-map decisions, shared by its candidates. */
  clipMaps?: ClipMapCache;
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
  /**
   * The typed parameters the call will pass (src/call-parameters.ts), so they enter the request
   * digest; absent when it passes none.
   */
  parameters?: CallParameters;
}

/** What a kind's QA check reads: the candidate's media and what it was made for. */
export interface KindCheckInput {
  spec: AssetSpec;
  profile: TargetProfile;
  bible: StyleBible;
  output: MediaOutput;
}

/**
 * One QA check a kind declares (design section 11). Every check a kind's reasons name, from
 * `generate` or from a check's `run`, is declared here: core judges each reason by its
 * declaration, and a reason neither its kind nor core declares is advisory (`cause: "undeclared"`)
 * and never filters.
 *
 * - `exact`: deterministic and free. With `run`, core runs it under a `Caller` that refuses every
 *   call, and the conformance suite runs it twice and fails it when it calls or answers
 *   differently. Its reasons filter.
 * - `model`: a model's answer decides it. With
 *   `run`, it may call a model through the candidate's `Caller`; its calls belong in the kind's
 *   `planCandidate`. Its reasons filter only with a qualifying stability entry (core's
 *   src/qa/stability.json, or the kind's own `stability`) for its name, its version and the model
 *   its `operation`'s route resolves to on the run; otherwise they are advisory.
 * - `gated`: core's kinds only: a model decision core gates by its own rule (a 3D character's
 *   facing, the identity lock). A pack declaring it is refused at load.
 */
export interface KindCheck {
  /**
   * The `check` its reasons carry. A name ending in `*` declares a family: every check whose name
   * starts with what precedes the `*` (`clip-*` covers `clip-walk`).
   */
  name: string;
  mode: "exact" | "model" | "gated";
  /** Bumped when what the check asks or measures changes; a stability entry holds for one. "1" when absent. */
  version?: string;
  /** The `source` of the reasons it covers; absent: every source. */
  source?: Reason["source"];
  /** A `model` check: the operation whose route's model answers it. Without one it never filters. */
  operation?: string;
  /** Runs the check on a candidate. Absent: a declaration only; the kind's `generate` returns its reasons. */
  run?(input: KindCheckInput, call: Caller): Promise<Reason[]> | Reason[];
}

export interface Generator {
  /** The `kind` of asset spec this generator handles. */
  kind: string;
  /**
   * How the kind's output is cut into frames. A `strip` kind's output carries core's frame layout
   * as `output.fields.frames` (`FrameLayout`, src/frames.ts), which core checks after `generate`,
   * and gets core's frame features: plan/apply, contact-sheet key frames, strip thumbnails and
   * staleness, the atlas presets. `single`: one image. Absent: the kind has no frames.
   */
  frames?: FramesTrait;
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
  /**
   * The QA checks the kind declares: every check its reasons name. Core runs those with a `run` on
   * each candidate after `generate`. Absent: none, so every reason the kind returns is undeclared.
   */
  checks?: KindCheck[];
  /**
   * Measured stability entries for the kind's `model` checks (src/qa/stability.ts), each with
   * `measuredBy` and the sha256 of its labelled set; core validates them when the kind loads.
   */
  stability?: StabilityEntry[];
  /**
   * The operations the kind calls, each with a role of core's role table (`ROLE_CAPABILITY` in
   * src/routes.ts). A pack's are `<pack name>:<op>`; core's kinds name core operations. Core
   * routes each like a core operation: `routes.<op>`, then `roles.<role>`, then the role's default.
   */
  operations?: Readonly<Record<string, string>>;
  /**
   * Validates every spec of this kind (the whole spec object); an invalid one is refused before
   * any spend, naming the field. It may not declare a routing field (an endpoint, model, provider,
   * provider options, graph or command): model, tier and price stay on the route in settings.
   */
  specSchema?: ZodType;
  /**
   * Validates the target profile's `kinds.<kind>` block, without its `values`. Without one the
   * block accepts only `values`. The same routing fields are refused.
   */
  profileSchema?: ZodType;
}

/**
 * The reasons of a kind's checks on one candidate: each `exact` check under a `RefusingCaller`
 * (`exactCaller`), every other one under the candidate's `call`. A declaration without `run` runs
 * nothing.
 */
export async function runKindChecks(
  checks: readonly KindCheck[],
  input: KindCheckInput,
  call: Caller,
  exactCaller: () => Caller,
): Promise<Reason[]> {
  const reasons: Reason[] = [];
  for (const check of checks)
    if (check.run !== undefined)
      reasons.push(...(await check.run(input, check.mode === "exact" ? exactCaller() : call)));
  return reasons;
}
