import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { InputError } from "../src/errors.ts";
import type { DecisionRequest, ModelRequest } from "../src/gateway/provider.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import type { Script } from "../src/gateway/scripted.ts";
import { encodePng } from "../src/image/raster.ts";
import { planStage, stage } from "../src/loop.ts";
import { character3dGenerator } from "../src/model3d/generator.ts";
import { REFERENCE_VIEWS, ReferenceViewCache, referenceViews } from "../src/model3d/views.ts";
import { sha256 } from "../src/request.ts";
import { REFERENCE_VIEW_OPERATION, defaultRoutes } from "../src/routes.ts";
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

/** A bible of the given references (role and, when declared, view), each a distinct image. */
async function world(refs: Array<{ role: string; view?: string }>) {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-views-")));
  await mkdir(join(dir, "refs"));
  const bible: StyleBible = {
    version: "2026-11-15",
    palette: PALETTE,
    references: [],
    perspective: "refs/perspective.png",
    subjects: { fern: { description: "a lean grey fox" } },
  };
  for (const [i, ref] of refs.entries()) {
    const path = `refs/ref-${i}.png`;
    await writeFile(join(dir, path), encodePng(drawSubject(64, i * 5)));
    bible.references.push({
      path,
      role: ref.role,
      subject: "fern",
      ...(ref.view !== undefined && { view: ref.view }),
    });
  }
  return { dir, bible, runs: join(dir, "runs"), state: join(dir, "state") };
}

/** The role the view prompt names. */
const roleOf = (request: DecisionRequest) => /names its role: "([^"]*)"/.exec(request.prompt)![1]!;

/** The 3D script, with a view model that answers from `views` by role. */
function provider(views: Record<string, string>) {
  const script: Script = {
    ...script3d,
    referenceView(request) {
      assert.equal(request.question.type, "choice");
      const view = views[roleOf(request)];
      if (view === undefined) throw new Error(`no scripted view for "${roleOf(request)}"`);
      return {
        answer: { type: "choice", choice: view, probabilities: { [view]: 0.9 } },
        costUsd: 0.00003,
      };
    },
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

const viewCalls = (p: ScriptedProvider) =>
  p.calls.filter(
    (c) => c.kind === "decide" && c.request.operation === REFERENCE_VIEW_OPERATION,
  ) as Array<{ kind: "decide"; request: DecisionRequest }>;
const modelCalls = (p: ScriptedProvider) =>
  p.calls.filter((c) => c.kind === "model").map((c) => c.request as ModelRequest);

test("a role that names no view is judged from the image, and the front view goes first", async () => {
  const w = await world([
    { role: "character sheet" },
    { role: "hero" },
    { role: "portrait" },
    { role: "turnaround" },
  ]);
  const p = provider({
    "character sheet": "back",
    hero: "front",
    portrait: "detail",
    turnaround: "sheet",
  });
  const { run } = await stage(stageOptions(w, p));
  assert.equal(run.errors.length, 0, run.errors.join("\n"));
  // One choice decision per reference, each shown the image and its role.
  const calls = viewCalls(p);
  assert.equal(calls.length, 4);
  for (const c of calls) {
    assert.equal(c.request.images.length, 1);
    assert.deepEqual(
      Object.keys((c.request.question as { options: object }).options),
      Object.keys(REFERENCE_VIEWS),
    );
  }
  // The provider gets the front view first and each reference by the view it shows.
  const [model] = modelCalls(p);
  assert.deepEqual(
    model!.views.map((v) => v.view),
    ["front", "back", "detail", "sheet"],
  );
  const provenance = run.candidates[0]!.provenance;
  const references = provenance.parameters["references"] as Array<Record<string, unknown>>;
  assert.deepEqual(
    references.map((r) => [r["role"], r["view"], r["viewSource"]]),
    [
      ["hero", "front", "judged"],
      ["character sheet", "back", "judged"],
      ["portrait", "detail", "judged"],
      ["turnaround", "sheet", "judged"],
    ],
  );
  // Each choice and its probability is recorded beside the other calls.
  const judged = provenance.calls.filter((c) => c.route.includes(REFERENCE_VIEW_OPERATION));
  assert.equal(judged.length, 4);
  for (const c of judged) {
    assert.equal(c.decision?.question, "choice");
    assert.equal(c.decision?.value, 0.9);
    assert.ok(Object.hasOwn(REFERENCE_VIEWS, c.decision!.label));
  }
});

test('"left side" and "right side" stay distinct, and a declared view wins', async () => {
  const w = await world([
    { role: "front", view: "front" },
    { role: "left side" },
    { role: "right side" },
    { role: "paw underside" },
  ]);
  const p = provider({ "left side": "left", "right side": "right", "paw underside": "detail" });
  const { run } = await stage(stageOptions(w, p));
  assert.equal(run.errors.length, 0, run.errors.join("\n"));
  // The declared front view needs no call.
  assert.deepEqual(viewCalls(p).map(roleOfCall), ["left side", "right side", "paw underside"]);
  const [model] = modelCalls(p);
  assert.deepEqual(
    model!.views.map((v) => v.view),
    ["front", "left", "right", "detail"],
  );
  const references = run.candidates[0]!.provenance.parameters["references"] as Array<
    Record<string, unknown>
  >;
  assert.equal(references[0]!["viewSource"], "declared");
});

function roleOfCall(c: { request: DecisionRequest }) {
  return roleOf(c.request);
}

test("a request with no front view is refused before the 3D call, naming each reference", async () => {
  const w = await world([{ role: "character sheet" }, { role: "left side" }]);
  const p = provider({ "character sheet": "sheet", "left side": "left" });
  await assert.rejects(stage(stageOptions(w, p)), (error: Error) => {
    assert.ok(error instanceof InputError);
    assert.match(error.message, /no approved reference shows the character's front view/);
    assert.match(
      error.message,
      /refs\/ref-0\.png \("character sheet"\): sheet \(judged, p 0\.90\)/,
    );
    assert.match(error.message, /refs\/ref-1\.png \("left side"\): left \(judged, p 0\.90\)/);
    return true;
  });
  assert.equal(viewCalls(p).length, 2);
  assert.equal(modelCalls(p).length, 0, "no expensive call");
  assert.equal(
    p.calls.some((c) => c.kind === "rig" || c.kind === "animate"),
    false,
  );
});

test("view calls are forecast once per request and judged once, then cached by sha256", async () => {
  const w = await world([{ role: "front", view: "front" }, { role: "hero" }, { role: "portrait" }]);
  const plan = planStage({ ...stageOptions(w, provider({})), candidates: 2 });
  assert.deepEqual(
    plan.perRequest.map((c) => c.operation),
    [REFERENCE_VIEW_OPERATION, REFERENCE_VIEW_OPERATION],
  );
  const perCandidate = plan.perCandidate.reduce((s, c) => s + c.estimatedCostUsd, 0);
  assert.equal(plan.calls, plan.perCandidate.length * 2 + 2);
  assert.ok(
    Math.abs(
      plan.estimateUsd -
        (perCandidate * 2 + 2 * defaultRoutes[REFERENCE_VIEW_OPERATION]!.estimatedCostUsd),
    ) < 1e-9,
  );
  // Without the bible, nothing is forecast for the request.
  const noBible: Omit<ReturnType<typeof stageOptions>, "bible"> & { bible?: StyleBible } = {
    ...stageOptions(w, provider({})),
  };
  delete noBible.bible;
  assert.deepEqual(planStage(noBible).perRequest, []);

  // Two candidates judge each image once.
  const p = provider({ hero: "back", portrait: "left" });
  const first = await stage(stageOptions(w, p, 2));
  assert.equal(first.run.errors.length, 0, first.run.errors.join("\n"));
  assert.equal(viewCalls(p).length, 2);
  assert.equal(modelCalls(p).length, 2);
  // The cache keeps each answer by the image's sha256 under the state directory.
  const files = (await readdir(join(w.state, "reference-views"))).sort();
  assert.deepEqual(
    files,
    w.bible.references
      .slice(1)
      .map((r) => r.path)
      .map((path) => `${sha256(new Uint8Array(readFileSync(join(w.dir, path))))}.json`)
      .sort(),
  );

  // A later request reads the cache and calls no view model.
  const again = provider({});
  const second = await stage(stageOptions(w, again));
  assert.equal(second.run.errors.length, 0, second.run.errors.join("\n"));
  assert.equal(viewCalls(again).length, 0);
  const references = second.run.candidates[0]!.provenance.parameters["references"] as Array<
    Record<string, unknown>
  >;
  assert.deepEqual(
    references.map((r) => [r["view"], r["viewSource"]]),
    [
      ["front", "declared"],
      ["back", "cached"],
      ["left", "cached"],
    ],
  );
});

test("referenceViews refuses a declared view that is not one, and a judged answer outside the options", async () => {
  const bytes = encodePng(drawSubject(32, 1));
  const ref = {
    role: "front",
    path: "refs/a.png",
    mediaType: "image/png",
    bytes,
    sha256: sha256(bytes),
  };
  const caller = (script: Partial<Script>) =>
    new Caller({
      provider: new ScriptedProvider({
        image: () => ({ images: [] }),
        vision: () => ({ text: "" }),
        ...script,
      }),
      budget: new Budget(1),
      routes: defaultRoutes,
    });
  await assert.rejects(
    referenceViews(caller({}), [{ ...ref, declared: "side" }], new ReferenceViewCache()),
    /declares view "side"/,
  );
  await assert.rejects(
    referenceViews(
      caller({
        referenceView: () => ({ answer: { type: "choice", choice: "upside-down" } }),
      }),
      [ref],
      new ReferenceViewCache(),
    ),
    /not an option/,
  );
});

test("a judged view whose model reports no probability records none, not certainty", async () => {
  const bytes = encodePng(drawSubject(32, 2));
  const ref = {
    role: "hero",
    path: "refs/b.png",
    mediaType: "image/png",
    bytes,
    sha256: sha256(bytes),
  };
  const caller = new Caller({
    provider: new ScriptedProvider({
      image: () => ({ images: [] }),
      vision: () => ({ text: "" }),
      referenceView: () => ({ answer: { type: "choice", choice: "front" } }),
    }),
    budget: new Budget(1),
    routes: defaultRoutes,
  });
  const cache = new ReferenceViewCache();
  const [judged] = await referenceViews(caller, [ref], cache);
  assert.equal(judged!.view, "front");
  assert.equal(judged!.probability, undefined);
  const decision = caller.records.at(-1)!.decision!;
  assert.equal(decision.label, "front");
  assert.equal(decision.value, undefined);
  assert.equal(decision.raw, undefined);
});
