import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRun } from "../src/commands/result.ts";
import { ExtensionError } from "../src/extensions/errors.ts";
import { coreExtension } from "../src/extensions/core.ts";
import { checkExtension } from "../src/extensions/registry.ts";
import { EXTENSION_API } from "../src/extension/api.ts";
import type { Extension } from "../src/extension/api.ts";
import type { Generator, KindCheck } from "../src/generators/generator.ts";
import { imageGenerators } from "../src/generators/image.ts";
import { stage } from "../src/loop.ts";
import {
  applyStability,
  checkOf,
  parseStability,
  qaRegistry,
  IMAGE_QA_CHECKS,
} from "../src/qa/stability.ts";
import type { StabilityEntry } from "../src/qa/stability.ts";
import { defaultRoutes } from "../src/routes.ts";
import { runConformance } from "../src/testing/conformance.ts";
import { sampleProfile, samplePng } from "../src/testing/samples.ts";
import type { Reason } from "../src/types.ts";
import { scriptedProvider, shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

const KIND = "probe:tile";
const MODEL = defaultRoutes.vision.model;

const reason = (check: string, passed: boolean, source: Reason["source"]): Reason => ({
  check,
  passed,
  reason: `${check} ${passed ? "ok" : "failed"}`,
  source,
});

const entry = (over: Partial<StabilityEntry> = {}): StabilityEntry => ({
  checkId: "tile-look",
  version: "1",
  model: MODEL,
  cases: 40,
  passCases: 20,
  failCases: 20,
  falsePasses: 1,
  falseFails: 2,
  repeats: 3,
  agreement: 0.95,
  measuredAt: "2026-11-14T00:00:00.000Z",
  measuredBy: "a synthetic fixture",
  labelledSetSha256: "a".repeat(64),
  ...over,
});

function without(field: keyof StabilityEntry): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...entry() };
  delete copy[field];
  return copy;
}

function fixtureKind(over: Partial<Generator> = {}, generated: Reason[] = []): Generator {
  return {
    kind: KIND,
    planCandidate: () => [],
    generate: async () => ({
      output: { mediaType: "image/png", extension: "png", bytes: samplePng(), fields: {} },
      qa: { passed: generated.every((r) => r.passed), reasons: generated },
      prompt: "a probe tile",
      parameters: {},
    }),
    ...over,
  };
}

const exactCheck = (passed: boolean): KindCheck => ({
  name: "tile-size",
  mode: "exact",
  source: "deterministic",
  run: () => [reason("tile-size", passed, "deterministic")],
});

const modelCheck: KindCheck = {
  name: "tile-look",
  mode: "model",
  operation: "vision",
  source: "vision",
  run: () => [reason("tile-look", false, "vision")],
};

async function stageProbe(kind: Generator, stability?: StabilityEntry[]) {
  const world = await syntheticWorld();
  return stage({
    spec: { ...shelterSpec, kind: KIND },
    specDir: world.dir,
    bible: world.bible,
    bibleDir: world.bibleDir,
    profile: world.profile,
    routes: defaultRoutes,
    provider: scriptedProvider(),
    providerName: "scripted",
    generators: [...(coreExtension.kinds ?? []), kind],
    runsDir: world.runsDir,
    candidates: 1,
    ...(stability !== undefined && { stability }),
  });
}

const packOf = (kind: Generator): Extension => ({
  api: EXTENSION_API,
  name: "probe",
  kinds: [kind],
});

test("a failing exact check of a pack kind filters the candidate", async () => {
  const { run } = await stageProbe(fixtureKind({ checks: [exactCheck(false)] }));
  assert.equal(run.filtered, 1);
  assert.equal(run.candidates.length, 0);
  assert.equal(
    run.filtering?.find((f) => f.check === "tile-size"),
    undefined,
  );
});

test("a passing exact check keeps the candidate", async () => {
  const { run } = await stageProbe(fixtureKind({ checks: [exactCheck(true)] }));
  assert.equal(run.filtered, 0);
  assert.equal(run.candidates.length, 1);
});

test("a failing model check is advisory without an entry: kept, shadow, no-entry", async () => {
  const { run } = await stageProbe(fixtureKind({ checks: [modelCheck] }));
  assert.equal(run.candidates.length, 1);
  const kept = run.candidates[0]?.reasons.find((r) => r.check === "tile-look");
  assert.equal(kept?.shadow, true);
  assert.equal(kept?.passed, false);
  assert.deepEqual(run.filtering, [{ check: "tile-look", state: "advisory", cause: "no-entry" }]);
});

test("a failing model check filters with a qualifying entry the kind ships", async () => {
  const { run } = await stageProbe(fixtureKind({ checks: [modelCheck], stability: [entry()] }));
  assert.equal(run.filtered, 1);
  assert.equal(run.candidates.length, 0);
  assert.deepEqual(run.filtering, [{ check: "tile-look", state: "filtering" }]);
});

test("a kind's entry for another model or version leaves the check advisory", async () => {
  const other = await stageProbe(
    fixtureKind({ checks: [modelCheck], stability: [entry({ model: "example/other" })] }),
  );
  assert.equal(other.run.candidates.length, 1);
  assert.deepEqual(other.run.filtering, [
    { check: "tile-look", state: "advisory", cause: "model-differs" },
  ]);
  const versioned = await stageProbe(
    fixtureKind({ checks: [{ ...modelCheck, version: "2" }], stability: [entry()] }),
  );
  assert.equal(versioned.run.candidates.length, 1);
});

test("a kind's entry too thin to qualify leaves the check advisory", async () => {
  const { run } = await stageProbe(
    fixtureKind({
      checks: [modelCheck],
      stability: [entry({ passCases: 5, cases: 25 })],
    }),
  );
  assert.equal(run.candidates.length, 1);
});

test("parseStability refuses an entry without measuredBy or a valid labelledSetSha256", () => {
  const noBy = without("measuredBy");
  assert.throws(() => parseStability([noBy]), /measuredBy/);
  assert.throws(() => parseStability([entry({ measuredBy: "  " })]), /measuredBy/);
  const noSha = without("labelledSetSha256");
  assert.throws(() => parseStability([noSha]), /labelledSetSha256/);
  for (const bad of ["abc", "A".repeat(64), "g".repeat(64), "a".repeat(65)])
    assert.throws(() => parseStability([entry({ labelledSetSha256: bad })]), /labelledSetSha256/);
  assert.equal(parseStability([entry()]).length, 1);
});

test("loading a pack refuses a kind's entries that name no measurer, hash or model check", () => {
  const refused = (kind: Generator) => {
    try {
      checkExtension(packOf(kind), "the pack");
    } catch (error) {
      assert.ok(error instanceof ExtensionError);
      assert.equal(error.code, "extension_refused");
      return error.message;
    }
    assert.fail("the pack should have been refused");
  };
  const noBy = without("measuredBy");
  assert.match(
    refused(fixtureKind({ checks: [modelCheck], stability: [noBy as unknown as StabilityEntry] })),
    /measuredBy/,
  );
  const noSha = without("labelledSetSha256");
  assert.match(
    refused(fixtureKind({ checks: [modelCheck], stability: [noSha as unknown as StabilityEntry] })),
    /labelledSetSha256/,
  );
  assert.match(
    refused(fixtureKind({ checks: [modelCheck], stability: [entry({ labelledSetSha256: "zz" })] })),
    /labelledSetSha256/,
  );
  assert.match(
    refused(fixtureKind({ checks: [modelCheck], stability: [entry({ checkId: "other" })] })),
    /not a "model" check/,
  );
  assert.match(
    refused(
      fixtureKind({ checks: [exactCheck(true)], stability: [entry({ checkId: "tile-size" })] }),
    ),
    /not a "model" check/,
  );
  assert.equal(
    checkExtension(packOf(fixtureKind({ checks: [modelCheck], stability: [entry()] })), "the pack")
      .name,
    "probe",
  );
});

test("an undeclared reason never filters: advisory, shadow, named in the review output", async () => {
  const kind = fixtureKind({}, [reason("tile-mood", false, "vision")]);
  const { run, runDir } = await stageProbe(kind);
  assert.equal(run.filtered, 0);
  assert.equal(run.candidates.length, 1);
  assert.equal(run.candidates[0]?.reasons[0]?.shadow, true);
  assert.deepEqual(run.filtering, [{ check: "tile-mood", state: "advisory", cause: "undeclared" }]);
  const text = formatRun(run, runDir);
  assert.match(text, /undeclared/);
  assert.match(text, /tile-mood is declared by neither its kind nor core/);
});

test("the conformance suite fails a kind whose generate returns an undeclared reason", async () => {
  const sample = {
    kinds: { [KIND]: { spec: { ...shelterSpec, kind: KIND }, profile: sampleProfile() } },
  };
  const undeclared = fixtureKind({}, [reason("tile-mood", true, "vision")]);
  const failing = await runConformance(packOf(undeclared), sample);
  assert.equal(failing.passed, false);
  assert.ok(failing.failures.some((f) => f.includes("tile-mood") && f.includes("declare")));

  const declared = fixtureKind(
    { checks: [{ name: "tile-mood", mode: "model", operation: "vision", source: "vision" }] },
    [reason("tile-mood", true, "vision")],
  );
  const passing = await runConformance(packOf(declared), sample);
  assert.deepEqual(passing.failures, []);
});

test("the conformance suite fails an exact check that returns an undeclared reason", async () => {
  const kind = fixtureKind({
    checks: [
      {
        name: "tile-size",
        mode: "exact",
        source: "deterministic",
        run: () => [reason("tile-extra", true, "deterministic")],
      },
    ],
  });
  const report = await runConformance(packOf(kind), {
    kinds: { [KIND]: { spec: { ...shelterSpec, kind: KIND }, profile: sampleProfile() } },
  });
  assert.equal(report.passed, false);
  assert.ok(report.failures.some((f) => f.includes("tile-extra")));
});

test("core's still kind leaves no undeclared state when staged", async () => {
  const world = await syntheticWorld();
  const { run } = await stage({
    spec: { ...shelterSpec, kind: "still", frames: { count: 1 } },
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
  });
  assert.equal(run.candidates.length, 2);
  assert.ok(!(run.filtering ?? []).some((f) => f.cause === "undeclared"));
  assert.ok(!(run.filtering ?? []).some((f) => f.state === "advisory" && f.cause === undefined));
});

test("every check id the 3D kind names is covered by core's registry; only image vision is model-backed", () => {
  const { checks } = qaRegistry(coreExtension.kinds ?? []);
  for (const id of [
    "clip-walk",
    "budget-triangles",
    "loop-walk",
    "contact-left",
    "gltf-validator",
  ]) {
    const found = checkOf({ check: id, source: "deterministic" }, checks);
    assert.ok(found, id);
    assert.equal(found.modelBacked, false, id);
  }
  for (const id of ["facing", "identity-lock"]) {
    const found = checkOf({ check: id, source: "decision" }, checks);
    assert.ok(found, id);
    assert.equal(found.modelBacked, false, id);
  }
  for (const id of ["identity", "perspective"]) {
    assert.equal(checkOf({ check: id, source: "vision" }, checks)?.modelBacked, true, id);
  }
  assert.equal(checkOf({ check: "tile-mood", source: "vision" }, checks), undefined);
  for (const c of IMAGE_QA_CHECKS)
    assert.ok(
      checks.some((d) => d.id === c.id),
      `${c.id} is declared by core's image kinds`,
    );
});

test("a pack re-declaring a core model check as exact does not make it filter", () => {
  const checks = [
    ...qaRegistry(coreExtension.kinds ?? []).checks,
    ...qaRegistry([{ checks: [{ name: "identity", mode: "exact" }] }]).checks,
  ];
  const result = applyStability([reason("identity", false, "vision")], defaultRoutes, {
    checks,
    entries: [],
    undeclared: "advisory",
  });
  assert.equal(result.passed, false, "no counted reason passed");
  assert.equal(result.reasons[0]?.shadow, true);
  assert.deepEqual(result.filtering, [{ check: "identity", state: "advisory", cause: "no-entry" }]);
});

/** A pack kind that declares core's checks as its own: what loading refuses, handed to `stage`. */
const intruder = (checks: KindCheck[], stability: StabilityEntry[] = []): Generator =>
  fixtureKind({ checks, stability });

async function stageStill(
  generators: Generator[],
  provider: Parameters<typeof scriptedProvider>[0] = {},
) {
  const world = await syntheticWorld();
  return stage({
    spec: { ...shelterSpec, kind: "still", frames: { count: 1 } },
    specDir: world.dir,
    bible: world.bible,
    bibleDir: world.bibleDir,
    profile: world.profile,
    routes: defaultRoutes,
    provider: scriptedProvider(provider),
    providerName: "scripted",
    generators,
    runsDir: world.runsDir,
    candidates: 2,
  });
}

test("a pack's entries for core's vision checks leave core's still advisory", async () => {
  const ids = ["transparency", "frame-count", "identity", "perspective"];
  const pack = intruder(
    ids.map((name) => ({ name, mode: "model", operation: "vision", source: "vision" })),
    ids.map((checkId) => entry({ checkId })),
  );
  const { run } = await stageStill([...imageGenerators, pack], { failIdentity: [0] });
  assert.equal(run.filtered, 0);
  assert.equal(run.candidates.length, 2);
  for (const id of ids)
    assert.deepEqual(
      run.filtering?.find((f) => f.check === id),
      { check: id, state: "advisory", cause: "no-entry" },
      id,
    );
});

test("a pack's model declaration of palette leaves core's palette check filtering", async () => {
  // Core's still kind, its candidates failing core's deterministic palette check.
  const still = imageGenerators.find((g) => g.kind === "still") as Generator;
  const offPalette: Generator = {
    ...still,
    generate: async (...args) => {
      const generated = await still.generate(...args);
      const bad = reason("palette", false, "deterministic");
      return { ...generated, qa: { passed: false, reasons: [...generated.qa.reasons, bad] } };
    },
  };
  const others = imageGenerators.filter((g) => g !== still);
  const alone = await stageStill([offPalette, ...others]);
  assert.equal(alone.run.filtered, 2, "core's palette check filters both");
  for (const pack of [
    intruder([{ name: "palette", mode: "model" }]),
    intruder([{ name: "pal*", mode: "model" }]),
  ]) {
    const { run } = await stageStill([offPalette, ...others, pack]);
    assert.equal(run.filtered, 2);
    assert.equal(
      run.filtering?.find((f) => f.check === "palette"),
      undefined,
    );
  }
});

test("loading a pack refuses a kind that declares a check core declares", () => {
  for (const name of ["palette", "identity", "clip-*", "clip-walk", "c*"]) {
    const kind = fixtureKind({ checks: [{ name, mode: "model" }] });
    assert.throws(
      () => checkExtension(packOf(kind), "probe"),
      (error: unknown) =>
        error instanceof ExtensionError &&
        error.code === "extension_refused" &&
        /overlaps core's check/.test(error.message),
      name,
    );
  }
  checkExtension(packOf(fixtureKind({ checks: [{ name: "tile-*", mode: "model" }] })), "probe");
});
