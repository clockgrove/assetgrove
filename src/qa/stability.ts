/**
 * Check stability: which QA checks are model-backed, and whether a model-backed check may filter.
 *
 * A model-backed check can answer the same input differently, and can agree with itself while being
 * wrong (always "passed", always 0.75). So it filters only with a measured entry in `stability.json`
 * for its id, version and the run's model that is both stable and right against labels: at least
 * `MIN_REPEATS` repeats and `MIN_AGREEMENT` agreement, and a labelled set with at least
 * `MIN_CLASS_CASES` should-pass and `MIN_CLASS_CASES` should-fail cases on which the check's
 * false-pass rate is at most `MAX_FALSE_PASS_RATE` and its false-fail rate at most
 * `MAX_FALSE_FAIL_RATE`. A class with too few labelled cases is not measured and never qualifies,
 * as in identity evaluation (src/identity-eval.ts). Otherwise its reasons are advisory: marked
 * `shadow` (recorded beside QA, never used to filter), and the result's `filtering` field says why.
 */
import { STYLE_VERDICT_OPERATION, defaultRoutes } from "../routes.ts";
import type { Route } from "../routes.ts";
import type { Reason } from "../types.ts";
import shipped from "./stability.json" with { type: "json" };

/** One QA check as declared in the registry. */
export interface QaCheck {
  /** The `check` its reasons carry. */
  id: string;
  /** Bumped when what the check asks or measures changes; an entry holds for one version. */
  version: string;
  /** Whether a model's answer decides the verdict. */
  modelBacked: boolean;
  /** The `source` of the reasons this declaration covers (one id can have a deterministic twin). */
  source: Reason["source"];
  /** Model-backed checks: the route whose model runs the check. */
  operation?: string;
}

/** A measured stability entry. */
export interface StabilityEntry {
  checkId: string;
  version: string;
  model: string;
  /** Distinct labelled inputs measured: `passCases + failCases`. */
  cases: number;
  /** Labelled cases the check should pass. */
  passCases: number;
  /** Labelled cases the check should fail. */
  failCases: number;
  /** Should-fail cases the check passed. */
  falsePasses: number;
  /** Should-pass cases the check failed. */
  falseFails: number;
  /** Times each input was judged. */
  repeats: number;
  /** Share of cases on which every repeat gave the same verdict, 0..1. */
  agreement: number;
  /** ISO time of the measurement. */
  measuredAt: string;
}

/** How one check took part in a result's verdict. */
export interface FilteringState {
  check: string;
  state: "filtering" | "advisory";
  /** Why an advisory check is advisory: no entry for its id and version, or none for this model. */
  cause?: "no-entry" | "model-differs";
}

export const MIN_REPEATS = 3;
export const MIN_AGREEMENT = 0.95;
/** Labelled cases needed of each class (should-pass, should-fail). */
export const MIN_CLASS_CASES = 15;
/** The most should-fail cases a filtering check may pass, as a share of them. */
export const MAX_FALSE_PASS_RATE = 0.05;
/** The most should-pass cases a filtering check may fail, as a share of them. */
export const MAX_FALSE_FAIL_RATE = 0.1;

const image = (id: string): QaCheck => ({
  id,
  version: "1",
  modelBacked: false,
  source: "deterministic",
});
const vision = (id: string, operation: string): QaCheck => ({
  id,
  version: "1",
  modelBacked: true,
  source: "vision",
  operation,
});

/** Image QA (src/qa.ts): deterministic pixel checks and the vision verdict's checks. */
export const IMAGE_QA_CHECKS: readonly QaCheck[] = [
  image("transparency"),
  image("frame-count"),
  image("palette"),
  vision("transparency", "vision"),
  vision("frame-count", "vision"),
  vision("identity", "vision"),
  vision("perspective", "vision"),
];

/**
 * Animation QA's model-backed checks (src/animation/flicker.ts, src/animation/holes.ts): typed
 * Boolean decisions (version 2, #376; version 1 read a label and a self-reported confidence from a
 * vision model's text).
 */
export const ANIMATION_VISION_CHECKS: readonly QaCheck[] = [
  {
    id: "identity-flicker",
    version: "2",
    modelBacked: true,
    source: "decision",
    operation: "flicker",
  },
  { id: "holes", version: "2", modelBacked: true, source: "decision", operation: "holes" },
];

/**
 * Stage's cut-out (src/generators/image.ts, #364): a typed Boolean decision on whether background
 * removal cut part of the subject away or left background attached.
 */
export const CUTOUT_CHECK: QaCheck = {
  id: "cutout",
  version: "1",
  modelBacked: true,
  source: "decision",
  operation: "cutout",
};

/**
 * Look-dev markings (src/model3d/lookdev/markings.ts): a typed decision judges each marking kept,
 * drifted or missing on the reference crop and the render crop (version 2, #365; version 1
 * measured pixels in boxes a vision model drew).
 */
export const LOOKDEV_MARKINGS_CHECK: QaCheck = {
  id: "lookdev-markings",
  version: "2",
  modelBacked: true,
  source: "decision",
  operation: "lookdev-marking",
};

/**
 * The planned run's style verdict (src/planning.ts): a typed Boolean decision on whether each
 * candidate violates the constitution or asset spec (version 2, #378; version 1 read a
 * self-reported styleScore from a vision model's JSON).
 */
export const STYLE_SCORE_CHECK: QaCheck = {
  id: "style-score",
  version: "2",
  modelBacked: true,
  source: "decision",
  operation: STYLE_VERDICT_OPERATION,
};

/**
 * The set-level audit's scores (src/commands/audit.ts): a vision model scores each member's style
 * against the bible's look and the set, and the identity decision model scores its likeness to its
 * subject's lock. They never filter; the audit marks each score advisory until it qualifies here.
 */
export const AUDIT_STYLE_CHECK: QaCheck = vision("audit-style", "vision");
export const AUDIT_IDENTITY_CHECK: QaCheck = vision("audit-identity", "identity");

/** The material pipeline's lit checks (src/material/pipeline.ts): a vision model judges the renders. */
export const MATERIAL_LIT_CHECKS: readonly QaCheck[] = [
  "flat-albedo",
  "normal-orientation",
  "emissive-placement",
  "dusk-rain",
  "night",
].map((id) => vision(id, "material-qa"));

/**
 * Every declared QA check that filters candidates. A check whose verdict a model decides is
 * declared here as model-backed; the coverage test reads this list.
 */
export const QA_CHECKS: readonly QaCheck[] = [
  ...IMAGE_QA_CHECKS,
  ...ANIMATION_VISION_CHECKS,
  CUTOUT_CHECK,
  LOOKDEV_MARKINGS_CHECK,
  STYLE_SCORE_CHECK,
  ...MATERIAL_LIT_CHECKS,
  AUDIT_STYLE_CHECK,
  AUDIT_IDENTITY_CHECK,
];

/** The model the coverage rule measures against: the core default vision model. */
export const DEFAULT_VISION_MODEL = defaultRoutes.vision.model;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isEntry(value: unknown): value is StabilityEntry {
  const e = value as Record<string, unknown> | null;
  return (
    e !== null &&
    typeof e === "object" &&
    typeof e["checkId"] === "string" &&
    typeof e["version"] === "string" &&
    typeof e["model"] === "string" &&
    isCount(e["cases"]) &&
    isCount(e["passCases"]) &&
    isCount(e["failCases"]) &&
    isCount(e["falsePasses"]) &&
    isCount(e["falseFails"]) &&
    typeof e["repeats"] === "number" &&
    typeof e["agreement"] === "number" &&
    typeof e["measuredAt"] === "string"
  );
}

/** Validates the entries of a stability file; throws on any malformed one. */
export function parseStability(value: unknown): StabilityEntry[] {
  if (!Array.isArray(value)) throw new Error("stability entries must be a JSON array");
  for (const [i, entry] of value.entries()) {
    if (!isEntry(entry)) {
      throw new Error(
        `stability entry ${i + 1} needs checkId, version, model, measuredAt (strings), cases, passCases, failCases, falsePasses, falseFails (counts) and repeats, agreement (numbers)`,
      );
    }
    if (
      entry.cases !== entry.passCases + entry.failCases ||
      entry.falsePasses > entry.failCases ||
      entry.falseFails > entry.passCases
    ) {
      throw new Error(
        `stability entry ${i + 1} is inconsistent: cases must be passCases + failCases, and wrong answers cannot exceed their class`,
      );
    }
  }
  return value as StabilityEntry[];
}

/** The measured entries shipped in src/qa/stability.json. */
export const STABILITY: readonly StabilityEntry[] = parseStability(shipped);

/** An entry's error rates against its labels; a class with no labelled cases has none (`undefined`). */
export function errorRates(
  entry: Pick<StabilityEntry, "passCases" | "failCases" | "falsePasses" | "falseFails">,
): { falsePassRate: number | undefined; falseFailRate: number | undefined } {
  return {
    falsePassRate: entry.failCases > 0 ? entry.falsePasses / entry.failCases : undefined,
    falseFailRate: entry.passCases > 0 ? entry.falseFails / entry.passCases : undefined,
  };
}

/** Whether an entry is enough for a check to filter: stable, and right often enough against labels. */
export function qualifies(entry: StabilityEntry): boolean {
  const { falsePassRate, falseFailRate } = errorRates(entry);
  return (
    entry.repeats >= MIN_REPEATS &&
    entry.agreement >= MIN_AGREEMENT &&
    entry.passCases >= MIN_CLASS_CASES &&
    entry.failCases >= MIN_CLASS_CASES &&
    falsePassRate !== undefined &&
    falsePassRate <= MAX_FALSE_PASS_RATE &&
    falseFailRate !== undefined &&
    falseFailRate <= MAX_FALSE_FAIL_RATE
  );
}

/** Whether a check filters on `model`, and why not when it does not. */
export function filteringState(
  check: QaCheck,
  model: string | undefined,
  entries: readonly StabilityEntry[] = STABILITY,
): FilteringState {
  if (!check.modelBacked) return { check: check.id, state: "filtering" };
  const qualifying = entries.filter(
    (e) => e.checkId === check.id && e.version === check.version && qualifies(e),
  );
  if (model !== undefined && qualifying.some((e) => e.model === model)) {
    return { check: check.id, state: "filtering" };
  }
  return {
    check: check.id,
    state: "advisory",
    cause: qualifying.length > 0 ? "model-differs" : "no-entry",
  };
}

/** The declaration a reason falls under, if any. */
export function checkOf(
  reason: Pick<Reason, "check" | "source">,
  checks: readonly QaCheck[] = QA_CHECKS,
): QaCheck | undefined {
  return checks.find((c) => c.id === reason.check && c.source === reason.source);
}

/**
 * Applies stability to a candidate's reasons: each model-backed check without a qualifying entry
 * for the model its route resolves to in `routes` has its reasons marked `shadow`. Returns the
 * reasons, whether every filtering reason passed, and one `filtering` state per model-backed check
 * among them.
 */
export function applyStability<R extends Reason>(
  reasons: R[],
  routes: Readonly<Record<string, Pick<Route, "model"> | undefined>>,
  options: { entries?: readonly StabilityEntry[]; checks?: readonly QaCheck[] } = {},
): { reasons: R[]; passed: boolean; filtering: FilteringState[] } {
  const states = new Map<string, FilteringState>();
  const out = reasons.map((reason) => {
    const check = checkOf(reason, options.checks);
    if (!check?.modelBacked) return reason;
    const model = check.operation === undefined ? undefined : routes[check.operation]?.model;
    const state = filteringState(check, model, options.entries);
    states.set(check.id, state);
    return state.state === "advisory" && !reason.shadow
      ? { ...reason, shadow: true as const }
      : reason;
  });
  const counted = out.filter((r) => !r.shadow);
  return {
    reasons: out,
    passed: counted.length > 0 && counted.every((r) => r.passed),
    filtering: [...states.values()],
  };
}

/** Merges filtering states across candidates: one per check, advisory over filtering. */
export function mergeFiltering(...groups: FilteringState[][]): FilteringState[] {
  const merged = new Map<string, FilteringState>();
  for (const s of groups.flat()) {
    const had = merged.get(s.check);
    if (!had || (had.state === "filtering" && s.state === "advisory")) merged.set(s.check, s);
  }
  return [...merged.values()];
}

/** The heading in docs/decisions.md whose one fenced JSON block lists the advisory checks. */
export const ADVISORY_HEADING = "## Model-backed checks advisory at 0.1";

/** The check ids in the fenced JSON block under `ADVISORY_HEADING` of docs/decisions.md. */
export function advisoryList(decisionsMarkdown: string): string[] {
  const start = decisionsMarkdown.indexOf(`${ADVISORY_HEADING}\n`);
  if (start < 0) throw new Error(`docs/decisions.md has no "${ADVISORY_HEADING}" section`);
  const rest = decisionsMarkdown.slice(start + ADVISORY_HEADING.length);
  const next = rest.search(/\n## /);
  const section = next < 0 ? rest : rest.slice(0, next);
  const blocks = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)];
  if (blocks.length !== 1) {
    throw new Error(`"${ADVISORY_HEADING}" must hold exactly one fenced JSON block`);
  }
  const list: unknown = JSON.parse(blocks[0]![1]!);
  if (!Array.isArray(list) || !list.every((id) => typeof id === "string")) {
    throw new Error("the advisory list must be a JSON array of check ids");
  }
  return list;
}

/**
 * Model-backed checks with neither a qualifying entry on `model` (the core default vision model)
 * nor a place in the advisory list: each one is a gap the coverage test fails on.
 */
export function coverageGaps(
  advisory: readonly string[],
  options: {
    checks?: readonly QaCheck[];
    entries?: readonly StabilityEntry[];
    model?: string;
  } = {},
): string[] {
  const model = options.model ?? DEFAULT_VISION_MODEL;
  const listed = new Set(advisory);
  const gaps = (options.checks ?? QA_CHECKS).filter(
    (c) =>
      c.modelBacked &&
      !listed.has(c.id) &&
      filteringState(c, model, options.entries).state !== "filtering",
  );
  return [...new Set(gaps.map((c) => c.id))];
}
