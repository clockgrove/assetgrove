import type { ZodType } from "zod";
import type { Caller } from "../calls.ts";
import type { CallParameters } from "../call-parameters.ts";
import type { ReferenceViewCache } from "../model3d/views.ts";
import type { ClipMapCache } from "../model3d/clip-map.ts";
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
 * One QA check a kind declares (design section 11). Core runs a kind's checks on each candidate
 * after `generate` and adds their reasons to its QA. An `exact` check is deterministic and free:
 * core runs it under a `Caller` that refuses every call, and the conformance suite runs it twice
 * and fails it when it calls or answers differently. A `judged` check may call a model through the
 * candidate's `Caller`; its calls belong in the kind's `planCandidate`.
 */
export interface KindCheck {
  /** The `check` its reasons carry. */
  name: string;
  mode: "exact" | "judged";
  run(input: KindCheckInput, call: Caller): Promise<Reason[]> | Reason[];
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
  /** QA checks core runs on each candidate after `generate`. Absent: none. */
  checks?: KindCheck[];
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
 * (`exactCaller`), each `judged` one under the candidate's `call`.
 */
export async function runKindChecks(
  checks: readonly KindCheck[],
  input: KindCheckInput,
  call: Caller,
  exactCaller: () => Caller,
): Promise<Reason[]> {
  const reasons: Reason[] = [];
  for (const check of checks)
    reasons.push(...(await check.run(input, check.mode === "exact" ? exactCaller() : call)));
  return reasons;
}
