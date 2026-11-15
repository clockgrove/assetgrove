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
  filteringState,
  parseStability,
  QA_CHECKS,
  STABILITY,
} from "../src/qa/stability.ts";
import type { StabilityEntry } from "../src/qa/stability.ts";
import { markingsReason } from "../src/model3d/lookdev/markings.ts";
import { defaultRoutes } from "../src/routes.ts";
import type { Routes } from "../src/routes.ts";
import type { Reason } from "../src/types.ts";
import { scriptedProvider, shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

const RUN_MODEL = defaultRoutes.vision.model;
const OTHER_MODEL = "example/other-vision-model";

const entry = (over: Partial<StabilityEntry> = {}): StabilityEntry => ({
  checkId: "identity",
  version: "1",
  model: RUN_MODEL,
  cases: 30,
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
  for (const weak of [entry({ cases: 29 }), entry({ repeats: 2 }), entry({ agreement: 0.949 })]) {
    const r = applyStability(reasons(), defaultRoutes, { entries: [weak] });
    assert.equal(r.passed, true);
    assert.deepEqual(r.filtering[0], { check: "identity", state: "advisory", cause: "no-entry" });
  }
  // An entry for another version of the check does not count.
  const old = applyStability(reasons(), defaultRoutes, { entries: [entry({ version: "0" })] });
  assert.equal(old.filtering[0]?.cause, "no-entry");
});

test("the shipped entries leave every model-backed check advisory at 0.1", () => {
  const result = applyStability(reasons(), defaultRoutes);
  assert.equal(result.passed, true);
  assert.deepEqual(result.filtering, [{ check: "identity", state: "advisory", cause: "no-entry" }]);
  assert.ok(Array.isArray(STABILITY));
});

test("an entry of cases 30, repeats 3, agreement 0.95 for the run's model filters", () => {
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

test("stability entries are validated", () => {
  assert.deepEqual(parseStability([entry()]), [entry()]);
  assert.throws(() => parseStability({}), /JSON array/);
  assert.throws(() => parseStability([{ checkId: "identity" }]), /stability entry 1/);
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
  // A qualifying entry on the core default vision model covers it instead.
  assert.deepEqual(
    coverageGaps(without, { entries: [entry({ checkId: "holes", model: DEFAULT_VISION_MODEL })] }),
    [],
  );
  // An entry on another model does not.
  assert.deepEqual(
    coverageGaps(without, { entries: [entry({ checkId: "holes", model: OTHER_MODEL })] }),
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
