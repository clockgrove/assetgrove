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
  /**
   * The `source` of the reasons this declaration covers (one id can have a deterministic twin);
   * absent: every source.
   */
  source?: Reason["source"];
  /** Model-backed checks: the route whose model runs the check. */
  operation?: string;
  /** The id ends in `*`: the declaration covers every check whose id starts with what precedes it. */
  family?: true;
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
  /** Who or what measured it (a person, or the script that ran the measurement). */
  measuredBy: string;
  /** The sha256 (64 lower-case hex) of the labelled set it was measured on. */
  labelledSetSha256: string;
}

/** How one check took part in a result's verdict. */
export interface FilteringState {
  check: string;
  state: "filtering" | "advisory";
  /**
   * Why an advisory check is advisory: no entry for its id and version, none for this model, or
   * neither the reason's kind nor core declares the check.
   */
  cause?: "no-entry" | "model-differs" | "undeclared";
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
 * Material map flicker (src/material/flicker.ts, #364): a typed choice decision judges each frame
 * pair the pixel comparison could not clear; only `flickers` fails. Its deterministic twin (pairs
 * cleared by pixels, or with no corresponding pixels) is not model-backed.
 */
export const MATERIAL_FLICKER_CHECK: QaCheck = {
  id: "material-flicker",
  version: "1",
  modelBacked: true,
  source: "decision",
  operation: "map-flicker",
};

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
  MATERIAL_FLICKER_CHECK,
  AUDIT_STYLE_CHECK,
  AUDIT_IDENTITY_CHECK,
];

/** The model the coverage rule measures against: the core default vision model. */
export const DEFAULT_VISION_MODEL = defaultRoutes.vision.model;

const SHA256 = /^[0-9a-f]{64}$/;

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
    typeof e["measuredAt"] === "string" &&
    typeof e["measuredBy"] === "string" &&
    e["measuredBy"].trim() !== "" &&
    typeof e["labelledSetSha256"] === "string" &&
    SHA256.test(e["labelledSetSha256"])
  );
}

/** Validates the entries of a stability file; throws on any malformed one. */
export function parseStability(value: unknown): StabilityEntry[] {
  if (!Array.isArray(value)) throw new Error("stability entries must be a JSON array");
  for (const [i, entry] of value.entries()) {
    const e = entry as Record<string, unknown> | null;
    if (e !== null && typeof e === "object") {
      if (typeof e["measuredBy"] !== "string" || e["measuredBy"].trim() === "")
        throw new Error(
          `stability entry ${i + 1} has no measuredBy: an entry names who or what measured it`,
        );
      if (typeof e["labelledSetSha256"] !== "string" || !SHA256.test(e["labelledSetSha256"]))
        throw new Error(
          `stability entry ${i + 1} has no labelledSetSha256: an entry names the sha256 (64 lower-case hex) of the labelled set it was measured on`,
        );
    }
    if (!isEntry(entry)) {
      throw new Error(
        `stability entry ${i + 1} needs checkId, version, model, measuredAt, measuredBy (strings), labelledSetSha256 (the labelled set's sha256, 64 lower-case hex), cases, passCases, failCases, falsePasses, falseFails (counts) and repeats, agreement (numbers)`,
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

/** Whether a declaration covers a check id: the same id, or a family's prefix. */
function covers(check: QaCheck, id: string): boolean {
  return check.family ? id.startsWith(check.id.slice(0, -1)) : check.id === id;
}

/**
 * The declaration a reason falls under, if any: one whose id (or family) and source cover it.
 * Where several do, a model-backed one wins, so redeclaring a model-backed check never makes its
 * reasons filter.
 */
export function checkOf(
  reason: Pick<Reason, "check" | "source">,
  checks: readonly QaCheck[] = QA_CHECKS,
): QaCheck | undefined {
  const found = checks.filter(
    (c) => covers(c, reason.check) && (c.source === undefined || c.source === reason.source),
  );
  return found.find((c) => c.modelBacked) ?? found[0];
}

/**
 * Applies stability to a candidate's reasons: each model-backed check without a qualifying entry
 * for the model its route resolves to in `routes` has its reasons marked `shadow`. With
 * `undeclared: "advisory"`, a reason no declaration in `checks` covers is marked `shadow` too, its
 * state `advisory` with cause `undeclared`. Returns the reasons, whether every filtering reason
 * passed, and one `filtering` state per model-backed or undeclared check among them.
 */
export function applyStability<R extends Reason>(
  reasons: R[],
  routes: Readonly<Record<string, Pick<Route, "model"> | undefined>>,
  options: {
    entries?: readonly StabilityEntry[];
    checks?: readonly QaCheck[];
    undeclared?: "advisory";
  } = {},
): { reasons: R[]; passed: boolean; filtering: FilteringState[] } {
  const states = new Map<string, FilteringState>();
  const out = reasons.map((reason) => {
    const check = checkOf(reason, options.checks);
    if (check === undefined && options.undeclared === "advisory") {
      states.set(reason.check, { check: reason.check, state: "advisory", cause: "undeclared" });
      return reason.shadow ? reason : { ...reason, shadow: true as const };
    }
    if (!check?.modelBacked) return reason;
    const model = check.operation === undefined ? undefined : routes[check.operation]?.model;
    const state = { ...filteringState(check, model, options.entries), check: reason.check };
    states.set(reason.check, state);
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

/** The QA checks and stability entries of a set of kinds: what they declare and ship. */
export interface QaRegistry {
  checks: QaCheck[];
  entries: StabilityEntry[];
}

/** One kind's check declaration as the registry holds it. */
export interface CheckDeclaration {
  name: string;
  mode: "exact" | "model" | "judged" | "gated";
  version?: string;
  source?: Reason["source"];
  operation?: string;
}

/** A declaration as a `QaCheck`: `model` (or `judged`) is model-backed; `exact` and `gated` are not. */
export function qaCheckOf(declaration: CheckDeclaration): QaCheck {
  return {
    id: declaration.name,
    version: declaration.version ?? "1",
    modelBacked: declaration.mode === "model" || declaration.mode === "judged",
    ...(declaration.source !== undefined && { source: declaration.source }),
    ...(declaration.operation !== undefined && { operation: declaration.operation }),
    ...(declaration.name.endsWith("*") && { family: true as const }),
  };
}

/** A core `QaCheck` as a kind's declaration, so core's kinds register through the same field. */
export function declarationOf(check: QaCheck): CheckDeclaration {
  return {
    name: check.id,
    mode: check.modelBacked ? "model" : "exact",
    version: check.version,
    ...(check.source !== undefined && { source: check.source }),
    ...(check.operation !== undefined && { operation: check.operation }),
  };
}

/**
 * The registry of the loaded kinds (core's among them): every check each declares, and the
 * entries core ships (`entries`, src/qa/stability.json by default) with those each kind ships.
 */
export function qaRegistry(
  kinds: ReadonlyArray<{
    checks?: readonly CheckDeclaration[];
    stability?: readonly StabilityEntry[];
  }>,
  entries: readonly StabilityEntry[] = STABILITY,
): QaRegistry {
  return {
    checks: kinds.flatMap((k) => (k.checks ?? []).map(qaCheckOf)),
    entries: [...entries, ...kinds.flatMap((k) => k.stability ?? [])],
  };
}

/** Whether two declarations cover a common check id: the same id, or a family over the other. */
export function overlaps(a: QaCheck, b: QaCheck): boolean {
  if (a.family && b.family) {
    const pa = a.id.slice(0, -1);
    const pb = b.id.slice(0, -1);
    return pa.startsWith(pb) || pb.startsWith(pa);
  }
  return covers(a, b.id) || covers(b, a.id);
}

/**
 * The registry one kind's reasons are judged by: core's kinds' checks and the entries core ships
 * (`entries`), with the kind's own declarations and entries. A pack kind's declaration that
 * overlaps a check core declares, or its entry for a check id core declares, is left out, so no
 * pack changes how core's checks filter, and one pack's declarations and entries never reach
 * another kind's reasons. Loading a pack refuses both (src/extensions/registry.ts); this holds
 * for kinds handed to `stage` directly too.
 */
export function kindQaRegistry(
  kind: { checks?: readonly CheckDeclaration[]; stability?: readonly StabilityEntry[] },
  core: ReadonlyArray<{
    checks?: readonly CheckDeclaration[];
    stability?: readonly StabilityEntry[];
  }>,
  entries: readonly StabilityEntry[] = STABILITY,
): QaRegistry {
  const base = qaRegistry(core, entries);
  if (core.includes(kind)) return base;
  const own = (kind.checks ?? [])
    .map(qaCheckOf)
    .filter((c) => !base.checks.some((b) => overlaps(b, c)));
  const ownEntries = (kind.stability ?? []).filter(
    (e) => !base.checks.some((b) => covers(b, e.checkId)),
  );
  return { checks: [...base.checks, ...own], entries: [...base.entries, ...ownEntries] };
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
