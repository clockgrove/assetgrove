/**
 * Check stability: which QA checks are model-backed, and whether a model-backed check may filter.
 *
 * A model-backed check can give different answers on the same input, so it filters only with a
 * measured entry in `stability.json` for its id, version and the run's model with at least
 * `MIN_CASES` cases, `MIN_REPEATS` repeats and `MIN_AGREEMENT` agreement. Otherwise its reasons
 * are advisory: marked `shadow` (recorded beside QA, never used to filter), and the result's
 * `filtering` field says why.
 */
import { defaultRoutes } from "../routes.ts";
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
  /** Distinct inputs measured. */
  cases: number;
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

export const MIN_CASES = 30;
export const MIN_REPEATS = 3;
export const MIN_AGREEMENT = 0.95;

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

/** Animation QA's vision checks (src/animation/flicker.ts, src/animation/holes.ts). */
export const ANIMATION_VISION_CHECKS: readonly QaCheck[] = [
  vision("identity-flicker", "flicker"),
  vision("holes", "holes"),
];

/**
 * Look-dev markings (src/model3d/lookdev/markings.ts): its pixels are measured, but in boxes a
 * vision model draws, so the model decides which markings are measured.
 */
export const LOOKDEV_MARKINGS_CHECK: QaCheck = {
  id: "lookdev-markings",
  version: "1",
  modelBacked: true,
  source: "deterministic",
  operation: "lookdev-markings",
};

/** The planned run's style verdict (src/planning.ts): a vision model scores each candidate. */
export const STYLE_SCORE_CHECK: QaCheck = vision("style-score", "planned-qa");

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
  LOOKDEV_MARKINGS_CHECK,
  STYLE_SCORE_CHECK,
  ...MATERIAL_LIT_CHECKS,
];

/** The model the coverage rule measures against: the core default vision model. */
export const DEFAULT_VISION_MODEL = defaultRoutes.vision.model;

function isEntry(value: unknown): value is StabilityEntry {
  const e = value as Record<string, unknown> | null;
  return (
    e !== null &&
    typeof e === "object" &&
    typeof e["checkId"] === "string" &&
    typeof e["version"] === "string" &&
    typeof e["model"] === "string" &&
    typeof e["cases"] === "number" &&
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
        `stability entry ${i + 1} needs checkId, version, model, measuredAt (strings) and cases, repeats, agreement (numbers)`,
      );
    }
  }
  return value as StabilityEntry[];
}

/** The measured entries shipped in src/qa/stability.json. */
export const STABILITY: readonly StabilityEntry[] = parseStability(shipped);

/** Whether an entry is enough for a check to filter. */
export function qualifies(entry: StabilityEntry): boolean {
  return (
    entry.cases >= MIN_CASES && entry.repeats >= MIN_REPEATS && entry.agreement >= MIN_AGREEMENT
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
