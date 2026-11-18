import "./fixtures/env.ts";
import { approveProfile } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { imageGenerators } from "../src/generators/image.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { setPixel } from "../src/image/raster.ts";
import { planStage, stage } from "../src/loop.ts";
import type { StageOptions } from "../src/loop.ts";
import { VISION_CHECKS } from "../src/qa.ts";
import type { StabilityEntry } from "../src/qa/stability.ts";
import { CUTOUT_OPERATION, defaultRoutes } from "../src/routes.ts";
import type { AssetSpec } from "../src/types.ts";
import { drawSubject, scriptedProvider, syntheticWorld } from "./fixtures/synthetic.ts";
import type { World } from "./fixtures/synthetic.ts";

const measured = (checkId: string, version: string, model: string): StabilityEntry => ({
  checkId,
  version,
  model,
  cases: 30,
  passCases: 15,
  failCases: 15,
  falsePasses: 0,
  falseFails: 0,
  repeats: 3,
  agreement: 0.95,
  measuredAt: "2026-11-17T00:00:00.000Z",
  measuredBy: "a synthetic fixture",
  labelledSetSha256: "0".repeat(64),
});

const VISION = VISION_CHECKS.map((id) => measured(id, "1", defaultRoutes.vision.model));
const CUTOUT = measured("cutout", "1", defaultRoutes[CUTOUT_OPERATION]!.model);

/** The synthetic fox with a soft grey shadow on the floor under it, as an image model draws one. */
function withShadow() {
  const r = drawSubject(96);
  for (let y = 80; y < 88; y++) {
    for (let x = 20; x < 76; x++) {
      const nx = (x - 48) / 28;
      const ny = (y - 84) / 4;
      if (nx * nx + ny * ny <= 1) setPixel(r, x, y, [200, 198, 194, 255]);
    }
  }
  return r;
}

/** The fixture's scripted provider with a `cutout` answer: yes for the candidates listed. */
function provider(faults: number[]): ScriptedProvider {
  return scriptedProvider({
    drawFrame: () => withShadow(),
    cutout: (i) => (faults.includes(i) ? 0.9 : 0.1),
    cutoutCostUsd: 0.0004,
  });
}

async function world(): Promise<World> {
  const w = await syntheticWorld();
  approveProfile(w.profile, { targetDir: w.targetDir });
  return w;
}

function options(
  w: World,
  p: StageOptions["provider"],
  stability: StabilityEntry[],
  spec: AssetSpec,
): StageOptions {
  return {
    spec,
    specDir: w.dir,
    bible: w.bible,
    bibleDir: w.bibleDir,
    profile: w.profile,
    routes: defaultRoutes,
    provider: p,
    providerName: "scripted",
    generators: imageGenerators,
    runsDir: w.runsDir,
    stability,
  };
}

const still: AssetSpec = { kind: "still", assetId: "den", animationFamily: "idle" };

test("cutout: one decision per candidate on the source and the cut-out over a contrasting colour; a yes filters the candidate", async () => {
  const w = await world();
  const p = provider([1]);
  const { run } = await stage(options(w, p, [...VISION, CUTOUT], still));
  const asked = p.calls.filter((c) => c.kind === "decide" && c.request.operation === "cutout");
  assert.equal(asked.length, 4, "one call per candidate");
  for (const c of asked) {
    assert.equal(c.kind, "decide");
    if (c.kind !== "decide") continue;
    assert.equal(c.request.images.length, 2, "the source and the cut-out");
    assert.equal(c.request.question.type, "boolean");
    assert.match(c.request.question.instructions, /missing.*background still attached/);
  }
  assert.equal(run.candidates.length, 3);
  assert.equal(run.filtered, 1);
  for (const c of run.candidates) {
    const r = c.reasons.find((x) => x.check === "cutout");
    assert.ok(r && r.passed && r.source === "decision" && !r.shadow);
  }
});

test("cutout: each call counts against the run's spend and is forecast with the candidate", async () => {
  const w = await world();
  const p = provider([]);
  const forecast = planStage(options(w, p, [...VISION, CUTOUT], still));
  assert.equal(forecast.perCandidate.filter((c) => c.operation === CUTOUT_OPERATION).length, 1);
  const planned = forecast.perCandidate.filter((c) => c.operation === CUTOUT_OPERATION);
  assert.equal(forecast.requested, 4);
  assert.equal(planned[0]!.estimatedCostUsd, 0.001);
  const { run } = await stage(options(w, p, [...VISION, CUTOUT], still));
  const freeProvider = scriptedProvider({
    drawFrame: () => withShadow(),
    cutout: () => 0.1,
    cutoutCostUsd: 0,
  });
  const free = await stage(options(w, freeProvider, [...VISION, CUTOUT], still));
  // The same run with free cutout answers: the difference is $0.0004 per candidate.
  assert.ok(Math.abs(run.spentUsd - free.run.spentUsd - 4 * 0.0004) < 1e-9);
});

test("cutout: unmeasured, a yes is recorded advisory beside QA and filters nothing", async () => {
  const w = await world();
  const p = provider([0, 1, 2, 3]);
  const { run } = await stage(options(w, p, VISION, still));
  assert.equal(run.candidates.length, 4);
  for (const c of run.candidates) {
    const r = c.reasons.find((x) => x.check === "cutout");
    assert.ok(r && !r.passed && r.shadow === true && r.source === "decision");
    assert.match(r.reason, /cut part of the subject away or left background attached/);
  }
});
