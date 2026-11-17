import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { imageGenerators } from "../src/generators/image.ts";
import { stage } from "../src/loop.ts";
import { combineQa, VISION_CHECKS } from "../src/qa.ts";
import {
  advisoryList,
  applyStability,
  coverageGaps,
  DEFAULT_VISION_MODEL,
  errorRates,
  filteringState,
  parseStability,
  qualifies,
  QA_CHECKS,
  STABILITY,
} from "../src/qa/stability.ts";
import type { StabilityEntry } from "../src/qa/stability.ts";
import { markingsFiltering, markingsReason } from "../src/model3d/lookdev/markings.ts";
import { defaultRoutes, LOOKDEV_MARKING_OPERATION } from "../src/routes.ts";
import type { Routes } from "../src/routes.ts";
import type { Reason } from "../src/types.ts";
import { scriptedProvider, shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

const RUN_MODEL = defaultRoutes.vision.model;
const OTHER_MODEL = "example/other-vision-model";

const entry = (over: Partial<StabilityEntry> = {}): StabilityEntry => ({
  checkId: "identity",
  version: "1",
  model: RUN_MODEL,
  cases: 40,
  passCases: 20,
  failCases: 20,
  falsePasses: 1,
  falseFails: 2,
  repeats: 3,
  agreement: 0.95,
  measuredAt: "2026-11-14T00:00:00.000Z",
  ...over,
});

/** A candidate whose deterministic checks pass and whose vision identity verdict fails. */
const reasons = (): Reason[] => [
  { check: "transparency", passed: true, reason: "ok", source: "deterministic" },
  { check: "palette", passed: true, reason: "ok", source: "deterministic" },
  { check: "identity", passed: false, reason: "a different character", source: "vision" },
];

test("a model-backed check without a qualifying entry filters nothing: advisory, no-entry", () => {
  const result = applyStability(reasons(), defaultRoutes, { entries: [] });
  assert.equal(result.passed, true, "the failing vision verdict does not filter the candidate");
  assert.deepEqual(result.filtering, [{ check: "identity", state: "advisory", cause: "no-entry" }]);
  const identity = result.reasons.find((r) => r.check === "identity");
  assert.equal(identity?.shadow, true, "its reason is recorded as advisory");
  assert.equal(identity?.passed, false, "its verdict is kept");
  assert.equal(combineQa(result.reasons).passed, true);

  // Entries below any bar do not qualify either.
  for (const weak of [entry({ repeats: 2 }), entry({ agreement: 0.949 })]) {
    const r = applyStability(reasons(), defaultRoutes, { entries: [weak] });
    assert.equal(r.passed, true);
    assert.deepEqual(r.filtering[0], { check: "identity", state: "advisory", cause: "no-entry" });
  }
  // An entry for another version of the check does not count.
  const old = applyStability(reasons(), defaultRoutes, { entries: [entry({ version: "0" })] });
  assert.equal(old.filtering[0]?.cause, "no-entry");
});

test("agreeing with itself is not enough: a check that is wrong often does not qualify", () => {
  const advisory = { check: "identity", state: "advisory", cause: "no-entry" };
  const cases = [
    // Always answers "passed": perfect agreement, every should-fail case passed.
    entry({ agreement: 1, falsePasses: 20, falseFails: 0 }),
    // Always scores 0.75 (a pass): the same, and nothing it fails is right either.
    entry({ agreement: 1, falsePasses: 20 }),
    // Always fails: every should-pass case failed.
    entry({ agreement: 1, falsePasses: 0, falseFails: 20 }),
    // Too few cases of one class: not measured.
    entry({ cases: 34, passCases: 20, failCases: 14, falsePasses: 0, falseFails: 0 }),
    entry({ cases: 34, passCases: 14, failCases: 20, falsePasses: 0, falseFails: 0 }),
    entry({ cases: 20, passCases: 20, failCases: 0, falsePasses: 0, falseFails: 0 }),
    // Rates just over the bars: 2 of 20 false passes (0.10), 3 of 20 false fails (0.15).
    entry({ falsePasses: 2 }),
    entry({ falseFails: 3 }),
  ];
  for (const weak of cases) {
    assert.equal(qualifies(weak), false);
    const r = applyStability(reasons(), defaultRoutes, { entries: [weak] });
    assert.equal(r.passed, true, "the check stays advisory");
    assert.deepEqual(r.filtering, [advisory]);
  }
  // Within both rates on enough cases of each class: qualifies and filters.
  const edge = entry({ falsePasses: 1, falseFails: 2 });
  assert.equal(qualifies(edge), true);
  assert.deepEqual(errorRates(edge), { falsePassRate: 0.05, falseFailRate: 0.1 });
  assert.equal(applyStability(reasons(), defaultRoutes, { entries: [edge] }).passed, false);
  assert.equal(
    qualifies(entry({ cases: 30, passCases: 15, failCases: 15, falsePasses: 0, falseFails: 0 })),
    true,
  );
});

test("the shipped entries leave every model-backed check advisory at 0.1", () => {
  const result = applyStability(reasons(), defaultRoutes);
  assert.equal(result.passed, true);
  assert.deepEqual(result.filtering, [{ check: "identity", state: "advisory", cause: "no-entry" }]);
  assert.ok(Array.isArray(STABILITY));
});

test("an entry labelled within both bars, repeats 3, agreement 0.95 for the run's model filters", () => {
  const result = applyStability(reasons(), defaultRoutes, { entries: [entry()] });
  assert.equal(result.passed, false, "the failing vision verdict filters the candidate");
  assert.deepEqual(result.filtering, [{ check: "identity", state: "filtering" }]);
  assert.equal(result.reasons.find((r) => r.check === "identity")?.shadow, undefined);
});

test("an entry for another model gives cause model-differs", () => {
  const result = applyStability(reasons(), defaultRoutes, {
    entries: [entry({ model: OTHER_MODEL })],
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.filtering, [
    { check: "identity", state: "advisory", cause: "model-differs" },
  ]);
  // The same entry on a run whose vision route uses the other model filters.
  const routes: Routes = {
    ...defaultRoutes,
    vision: { ...defaultRoutes.vision, model: OTHER_MODEL },
  };
  const onOther = applyStability(reasons(), routes, { entries: [entry({ model: OTHER_MODEL })] });
  assert.equal(onOther.passed, false);
  // And a non-default model turns filtering off for a check measured on the default.
  const offDefault = applyStability(reasons(), routes, { entries: [entry()] });
  assert.equal(offDefault.passed, true);
  assert.equal(offDefault.filtering[0]?.cause, "model-differs");
});

test("deterministic reasons sharing a model-backed check's id always filter", () => {
  const failing: Reason[] = [
    {
      check: "transparency",
      passed: false,
      reason: "no pixel is transparent",
      source: "deterministic",
    },
  ];
  const result = applyStability(failing, defaultRoutes, { entries: [] });
  assert.equal(result.passed, false);
  assert.deepEqual(result.filtering, []);
  assert.deepEqual(filteringState(QA_CHECKS[0]!, undefined, []), {
    check: "transparency",
    state: "filtering",
  });
});

test("lookdev-markings is advisory without an entry and filters with one", () => {
  const advisory = markingsReason([], { unmeasured: [] });
  assert.equal(advisory.shadow, true);
  assert.match(advisory.reason, /^advisory, never filters/);
  const filtering = markingsReason(
    [],
    { unmeasured: [] },
    { check: "lookdev-markings", state: "filtering" },
  );
  assert.equal(filtering.shadow, undefined);
  assert.doesNotMatch(filtering.reason, /advisory/);
});

test("the markings decision filters through the stability rule on the marking route's model", () => {
  const model = defaultRoutes[LOOKDEV_MARKING_OPERATION]!.model;
  const drifted = [
    markingsReason(
      [{ marking: "mask", view: "front", image: "default", verdict: "drifted", drifts: true }],
      { unmeasured: [] },
    ),
  ];
  assert.equal(drifted[0]!.source, "decision");
  const shipped = applyStability(drifted, defaultRoutes);
  assert.equal(shipped.reasons[0]!.shadow, true, "no entry: the verdict is advisory");
  assert.deepEqual(shipped.filtering, [
    { check: "lookdev-markings", state: "advisory", cause: "no-entry" },
  ]);
  const entries = [entry({ checkId: "lookdev-markings", version: "2", model })];
  const measured = applyStability(drifted, defaultRoutes, { entries });
  assert.equal(measured.passed, false, "a qualifying version 2 entry makes it filter");
  assert.deepEqual(measured.filtering, [{ check: "lookdev-markings", state: "filtering" }]);
  const old = applyStability(drifted, defaultRoutes, {
    entries: [entry({ checkId: "lookdev-markings", version: "1", model })],
  });
  assert.equal(
    old.filtering[0]?.state,
    "advisory",
    "an entry for the thresholded version does not count",
  );
  assert.equal(markingsFiltering(model).state, "advisory", "none is shipped");
});

test("stability entries are validated", () => {
  assert.deepEqual(parseStability([entry()]), [entry()]);
  assert.throws(() => parseStability({}), /JSON array/);
  assert.throws(() => parseStability([{ checkId: "identity" }]), /stability entry 1/);
  const unlabelled: Partial<ReturnType<typeof entry>> = entry();
  delete unlabelled.passCases;
  assert.throws(() => parseStability([unlabelled]), /stability entry 1 needs/);
  assert.throws(() => parseStability([entry({ cases: 39 })]), /inconsistent/);
  assert.throws(() => parseStability([entry({ falsePasses: 21 })]), /inconsistent/);
});

const decisions = () => readFile(new URL("../docs/decisions.md", import.meta.url), "utf8");

test("coverage: every model-backed check has a qualifying default-model entry or is listed advisory", async () => {
  const listed = advisoryList(await decisions());
  assert.deepEqual(coverageGaps(listed), [], "the repository passes");
  assert.equal(DEFAULT_VISION_MODEL, defaultRoutes.vision.model);
});

test("coverage: removing a check from the list while it has no entry fails", async () => {
  const text = await decisions();
  const listed = advisoryList(text);
  assert.ok(listed.includes("holes"));
  // An in-memory copy of docs/decisions.md with `holes` taken out of the list.
  const copy = text.replace(/"holes",\s*/, "");
  assert.notEqual(copy, text);
  const without = advisoryList(copy);
  assert.ok(!without.includes("holes"));
  assert.deepEqual(coverageGaps(without, { entries: [] }), ["holes"]);
  // A qualifying entry for the check's version (2, the typed decision, #376) on the core default
  // vision model covers it instead.
  const holes = { checkId: "holes", version: "2" };
  assert.deepEqual(
    coverageGaps(without, { entries: [entry({ ...holes, model: DEFAULT_VISION_MODEL })] }),
    [],
  );
  // An entry on another model does not, nor one measured on version 1 (the text reply).
  assert.deepEqual(coverageGaps(without, { entries: [entry({ ...holes, model: OTHER_MODEL })] }), [
    "holes",
  ]);
  assert.deepEqual(
    coverageGaps(without, {
      entries: [entry({ checkId: "holes", version: "1", model: DEFAULT_VISION_MODEL })],
    }),
    ["holes"],
  );
});

test("the advisory list is one fenced JSON block of check ids", () => {
  const head = "## Model-backed checks advisory at 0.1\n\n";
  assert.deepEqual(advisoryList(`${head}\`\`\`json\n["holes"]\n\`\`\`\n`), ["holes"]);
  assert.throws(() => advisoryList("# nothing"), /no "## Model-backed checks advisory at 0.1"/);
  assert.throws(
    () => advisoryList(`${head}\`\`\`json\n[]\n\`\`\`\n\`\`\`json\n[]\n\`\`\`\n`),
    /exactly one fenced JSON block/,
  );
  assert.throws(() => advisoryList(`${head}\`\`\`json\n{"a":1}\n\`\`\`\n`), /array of check ids/);
});

test("stage: a failing vision verdict filters only with a qualifying entry for the run's model", async () => {
  const world = await syntheticWorld();
  const run = (stability: StabilityEntry[]) =>
    stage({
      spec: shelterSpec,
      specDir: world.dir,
      bible: world.bible,
      bibleDir: world.bibleDir,
      profile: world.profile,
      routes: defaultRoutes,
      provider: scriptedProvider({ failIdentity: [0] }),
      providerName: "scripted",
      generators: imageGenerators,
      runsDir: world.runsDir,
      candidates: 2,
      stability,
    });
  const identity = (r: Awaited<ReturnType<typeof run>>) =>
    r.run.filtering?.find((f) => f.check === "identity");

  const advisory = await run([]);
  assert.deepEqual(
    advisory.run.candidates.map((c) => c.id),
    ["c1", "c2"],
  );
  assert.deepEqual(identity(advisory), { check: "identity", state: "advisory", cause: "no-entry" });

  const measured = VISION_CHECKS.map((checkId) => entry({ checkId }));
  const filtered = await run(measured);
  assert.deepEqual(
    filtered.run.candidates.map((c) => c.id),
    ["c2"],
  );
  assert.equal(filtered.run.filtered, 1);
  assert.deepEqual(identity(filtered), { check: "identity", state: "filtering" });

  const other = await run(measured.map((e) => ({ ...e, model: OTHER_MODEL })));
  assert.equal(other.run.candidates.length, 2);
  assert.deepEqual(identity(other), {
    check: "identity",
    state: "advisory",
    cause: "model-differs",
  });
});
