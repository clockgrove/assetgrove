import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import type { DecisionRequest } from "../src/gateway/provider.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import type { Script } from "../src/gateway/scripted.ts";
import { encodePng } from "../src/image/raster.ts";
import { planStage, stage } from "../src/loop.ts";
import { character3dGenerator } from "../src/model3d/generator.ts";
import { MODEL3D_FACING_OPERATION, defaultRoutes } from "../src/routes.ts";
import type { AssetSpec, StyleBible, TargetProfile } from "../src/types.ts";
import script3d from "./fixtures/model3d-script.ts";
import { PALETTE, drawSubject } from "./fixtures/synthetic.ts";

const profile: TargetProfile = {
  name: "synthetic-grove-3d",
  license: "MIT",
  frames: { width: 32, height: 32 },
  model3d: {
    format: "glb",
    budgets: { triangles: 40000, textureMaxPx: 2048, materials: 4, bones: 80, lods: 1 },
    forward: "+z",
    units: "m",
    turntable: { sizePx: 64 },
  },
  layout: {
    media: "characters/{{spec.assetId}}/{{spec.assetId}}.{{output.extension}}",
    manifest: "characters/{{spec.assetId}}/manifest.json",
  },
  manifest: { assetId: "{{spec.assetId}}" },
} as unknown as TargetProfile;

const spec: AssetSpec = {
  kind: "character-3d",
  assetId: "fern",
  subject: "fern",
  gait: "biped",
  clips: ["idle"],
} as AssetSpec;

/** One reference of the subject, with its front view declared. */
async function world() {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-facing-")));
  await mkdir(join(dir, "refs"));
  await writeFile(join(dir, "refs", "front.png"), encodePng(drawSubject(64, 0)));
  const bible: StyleBible = {
    version: "2026-11-15",
    palette: PALETTE,
    references: [{ path: "refs/front.png", role: "front", subject: "fern", view: "front" }],
    perspective: "refs/perspective.png",
    subjects: { fern: { description: "a lean grey fox" } },
  };
  return { dir, bible, runs: join(dir, "runs"), state: join(dir, "state") };
}

/** The 3D script, with a facing model that answers `choice` (a yaw, or "unclear"). */
function provider(choice: string) {
  const script: Script = {
    ...script3d,
    facing: () => ({
      answer: { type: "choice", choice, probabilities: { [choice]: 0.92 } },
      costUsd: 0.00003,
    }),
  };
  return new ScriptedProvider(script);
}

function stageOptions(w: Awaited<ReturnType<typeof world>>, p: ScriptedProvider, candidates = 1) {
  return {
    spec,
    specDir: w.dir,
    bible: w.bible,
    bibleDir: w.dir,
    profile,
    routes: defaultRoutes,
    provider: p,
    generators: [character3dGenerator],
    runsDir: w.runs,
    candidates,
    capUsd: 5,
    stateDir: w.state,
  };
}

const facingCalls = (p: ScriptedProvider) =>
  p.calls.filter(
    (c) => c.kind === "decide" && c.request.operation === MODEL3D_FACING_OPERATION,
  ) as Array<{ kind: "decide"; request: DecisionRequest }>;
const kinds = (p: ScriptedProvider) => p.calls.map((c) => c.kind);

test("a model that faces the route's way is judged once from four renders and rigged", async () => {
  const w = await world();
  const p = provider("90");
  const { run } = await stage(stageOptions(w, p, 2));
  assert.equal(run.errors.length, 0, run.errors.join("\n"));
  const calls = facingCalls(p);
  assert.equal(calls.length, 2, "one decision per candidate");
  for (const c of calls) {
    assert.equal(c.request.images.length, 4);
    const question = c.request.question as { options: Record<string, string> };
    assert.deepEqual(Object.keys(question.options), ["0", "90", "180", "270", "unclear"]);
    assert.doesNotMatch(c.request.prompt, /\+x|\+z|-x|-z/, "the prompt does not reveal the answer");
  }
  for (const candidate of run.candidates) {
    assert.equal(
      candidate.reasons.every((r) => r.passed || r.shadow),
      true,
      JSON.stringify(candidate.reasons),
    );
    const reason = candidate.reasons.find((r) => r.check === "facing")!;
    assert.equal(reason.passed, true);
    assert.equal(reason.source, "decision");
    assert.match(
      reason.reason,
      /answers \+x \(yaw 90, probability 0\.92\); the model3d route faces \+x/,
    );
    const provenance = candidate.provenance;
    const call = provenance.calls.find((c) => c.route.includes(MODEL3D_FACING_OPERATION))!;
    assert.equal(call.decision?.label, "90");
    assert.equal(call.decision?.value, 0.92);
    assert.ok(call.costUsd > 0, "the decision counts against the run's spend");
    assert.deepEqual(provenance.parameters["facing"], {
      answer: "+x",
      probability: 0.92,
      routeForward: "+x",
    });
  }
  assert.ok(kinds(p).includes("rig"));
  assert.ok(kinds(p).includes("animate"));
});

test("a model that faces another way fails with a reason and no rig is made", async () => {
  const w = await world();
  const p = provider("270");
  const { run } = await stage(stageOptions(w, p));
  assert.equal(run.errors.length, 0, run.errors.join("\n"));
  assert.equal(run.candidates.length, 0, "a candidate that fails is not staged");
  assert.equal(run.filtered, 1);
  const [candidate] = run.rejections!;
  assert.equal(candidate!.reasons.length, 1);
  const [reason] = candidate!.reasons;
  assert.equal(reason!.check, "facing");
  assert.equal(reason!.passed, false);
  assert.match(
    reason!.reason,
    /answers -x \(yaw 270, probability 0\.92\); the model3d route faces \+x/,
  );
  assert.match(reason!.reason, /not rigged/);
  assert.equal(kinds(p).includes("rig"), false, "no rig call");
  assert.equal(kinds(p).includes("animate"), false, "no clip call");
  assert.equal(
    p.calls.filter((c) => c.kind === "decide").length,
    facingCalls(p).length,
    "no identity call",
  );
  assert.deepEqual(
    candidate!.artifacts!.map((a) => basename(a)),
    ["facing-yaw-0.png", "facing-yaw-90.png", "facing-yaw-180.png", "facing-yaw-270.png"],
  );
});

test("an unclear answer fails the candidate too", async () => {
  const w = await world();
  const p = provider("unclear");
  const { run } = await stage(stageOptions(w, p));
  assert.equal(run.candidates.length, 0, "a candidate that fails is not staged");
  assert.equal(run.filtered, 1);
  const [candidate] = run.rejections!;
  const [reason] = candidate!.reasons;
  assert.equal(reason!.check, "facing");
  assert.equal(reason!.passed, false);
  assert.match(reason!.reason, /no render that clearly shows the front/);
  assert.equal(kinds(p).includes("rig"), false);
});

test("the facing decision is forecast for every candidate", () => {
  const plan = planStage({
    ...stageOptions({ dir: "", bible: {} as StyleBible, runs: "", state: "" }, provider("90")),
    candidates: 2,
  });
  const facing = plan.perCandidate.filter((c) => c.operation === MODEL3D_FACING_OPERATION);
  assert.equal(facing.length, 1);
  assert.equal(facing[0]!.model, defaultRoutes[MODEL3D_FACING_OPERATION]!.model);
  assert.equal(
    plan.perCandidate[1]!.operation,
    MODEL3D_FACING_OPERATION,
    "right after the model call",
  );
  assert.equal(plan.calls, plan.perCandidate.length * 2);
});
