import "./fixtures/env.ts";
import { gitTarget } from "./fixtures/git.ts";
import { approve, approveProfile } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readDigitalSourceType } from "../src/metadata.ts";
import { defaultRoutes } from "../src/routes.ts";
import { writeSettings } from "./fixtures/env.ts";
import { encodePng } from "../src/image/raster.ts";
import { parseGlb } from "../src/model3d/glb.ts";
import { clips as clipsOf, measure } from "../src/model3d/scene.ts";
import { PALETTE, drawSubject } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./fixtures/model3d-script.ts", import.meta.url));
const VALIDATOR = fileURLToPath(new URL("./fixtures/validator-3d.ts", import.meta.url));
approve(SCRIPT);

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[], extraEnv: Record<string, string> = {}): Promise<Result> {
  const env = { ...process.env, ...extraEnv };
  delete env["AI_GATEWAY_API_KEY"];
  delete env["TRIPO_API_KEY"];
  delete env["MESHY_API_KEY"];
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc = (r: Result): Record<string, any> => JSON.parse(r.stdout);

const profile3d = (overrides: Record<string, unknown> = {}) => ({
  format: "assetgrove-target-profile/1",
  name: "synthetic-grove-3d",
  license: "MIT",
  values: { creator: "Synthetic Grove" },
  frames: { width: 32, height: 32 },
  model3d: {
    format: "glb",
    budgets: { triangles: 40000, textureMaxPx: 2048, materials: 4, bones: 80, lods: 1 },
    forward: "+z",
    units: "m",
    turntable: { sizePx: 96 },
  },
  layout: {
    media: "characters/{{spec.assetId}}/{{spec.assetId}}.{{output.extension}}",
    manifest: "characters/{{spec.assetId}}/manifest.json",
  },
  manifest: {
    assetManifestVersion: 1,
    assetId: "{{spec.assetId}}",
    kind: "{{spec.kind}}",
    source: {
      kind: "generated",
      path: "{{output.path}}",
      mediaType: "{{output.mediaType}}",
      tool: "assetgrove",
    },
    license: "{{profile.license}}",
    credit: "{{provenance.outputGrant.attribution?}}",
    semantic: "{{spec.fields.semantic?}}",
    review: { status: "pending" },
    model: {
      extension: "{{output.extension}}",
      triangles: "{{output.triangles}}",
      textureMaxPx: "{{output.textureMaxPx}}",
      materials: "{{output.materials}}",
      bones: "{{output.bones}}",
      lods: "{{output.lods}}",
      clips: "{{output.clips}}",
      bounds: "{{output.bounds}}",
    },
    contentHash: "{{output.sha256}}",
  },
  review: { path: "review.status", pending: "pending" },
  validator: { command: [process.execPath, VALIDATOR, "{{manifest}}"] },
  ...overrides,
});

async function world(
  spec: Record<string, unknown> = {},
  profileOverrides: Record<string, unknown> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-3d-"));
  await mkdir(join(dir, "refs"));
  const roles = ["turnaround-front", "turnaround-side", "turnaround-back"];
  for (const [i, role] of roles.entries()) {
    await writeFile(join(dir, "refs", `${role}.png`), encodePng(drawSubject(64, i * 4)));
  }
  const bible = {
    format: "assetgrove-style-bible/1",
    referenceLicense: "NOASSERTION",
    version: "2026-11-10",
    palette: PALETTE,
    references: roles.map((role) => ({
      path: `refs/${role}.png`,
      role,
      subject: "fern",
      view: { "turnaround-front": "front", "turnaround-side": "left", "turnaround-back": "back" }[
        role
      ],
    })),
    perspective: "refs/turnaround-front.png",
    subjects: { fern: { description: "a lean grey fox with a dark mask and a ringed tail" } },
  };
  const files = {
    spec: join(dir, "spec.json"),
    bible: join(dir, "bible.json"),
    profile: join(dir, "profile.json"),
  };
  await writeFile(
    files.spec,
    JSON.stringify({
      kind: "character-3d",
      assetId: "fern",
      subject: "fern",
      gait: "biped",
      clips: ["idle"],
      heightM: 0.5,
      fields: { semantic: { role: "actor", entity: "grove.fern" } },
      ...spec,
    }),
  );
  await writeFile(files.bible, JSON.stringify(bible));
  await writeFile(files.profile, JSON.stringify(profile3d(profileOverrides)));
  const runs = join(dir, "runs");
  const target = join(dir, "target");
  gitTarget(target);
  approveProfile(profile3d(profileOverrides), { targetDir: target });
  const base = ["--spec", files.spec, "--bible", files.bible, "--profile", files.profile];
  return { dir, base, runs, target };
}

test("--dry-run forecasts every 3D call with no key, within $5 for 4 candidates", async () => {
  const w = await world();
  const r = await cli(["stage", ...w.base, "--dry-run", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const plan = doc(r)["plan"];
  assert.deepEqual(
    plan.perCandidate.map((c: { operation: string }) => c.operation),
    ["model3d", "model3d-facing", "rig3d", "clips3d", "identity"],
  );
  assert.equal(plan.requested, 4);
  assert.ok(plan.estimateUsd <= 5, `forecast ${plan.estimateUsd}`);
  assert.equal(plan.withinCap, true);
  assert.equal(existsSync(w.runs), false);

  const over = await cli(["stage", ...w.base, "--dry-run", "--cap", "1", "--json"]);
  assert.equal(over.code, 3);
  assert.equal(doc(over)["error"].code, "cap_refused");
});

test("enforce never filters a 3D character on identity: it scores in shadow and says why", async () => {
  const w = await world({}, { identity: { mode: "enforce" } });
  const dry = await cli(["stage", ...w.base, "--dry-run", "--json"]);
  assert.equal(dry.code, 0, dry.stderr);
  // No record check is forecast, because none runs.
  assert.deepEqual(
    doc(dry)["plan"].perCandidate.map((c: { operation: string }) => c.operation),
    ["model3d", "model3d-facing", "rig3d", "clips3d", "identity"],
  );
  const r = await cli([
    "stage",
    ...w.base,
    "--runs",
    w.runs,
    "--provider-script",
    SCRIPT,
    "--candidates",
    "2",
    "--json",
  ]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const run = doc(r);
  assert.equal(run["candidates"].length, 2);
  assert.equal(run["rejections"]?.length ?? 0, 0);
  // The script scores the second candidate 2.2 of 4 (0.55), below the 0.68 threshold.
  const low = run["candidates"][1];
  const reason = low.reasons.find((x: { check: string }) => x.check === "identity-lock");
  assert.equal(reason.passed, false);
  assert.equal(reason.shadow, true);
  assert.match(
    reason.reason,
    /< threshold 0\.68 .*shadow mode, not filtered: enforce does not filter 3D characters: no identity question separates lit renders of the right character from their drift/,
  );
  assert.equal(low.fields.identity.mode, "shadow");
  assert.equal(low.fields.identity.filtered, false);
  assert.match(low.fields.identity.shadowReason, /enforce does not filter 3D characters/);
  assert.deepEqual(
    low.provenance.calls.map((c: { operation: string }) => c.operation),
    ["model3d", "model3d-facing", "rig3d", "clips3d", "identity"],
  );
});

test("a run reserves the whole forecast before any call and refuses over the cap", async () => {
  const w = await world();
  const r = await cli([
    "stage",
    ...w.base,
    "--runs",
    w.runs,
    "--provider-script",
    SCRIPT,
    "--cap",
    "2",
    "--json",
  ]);
  assert.equal(r.code, 3, r.stdout + r.stderr);
  assert.equal(doc(r)["error"].code, "cap_refused");
  assert.equal(existsSync(w.runs), false, "nothing staged");
});

test("stage writes rigged candidates with clips, renders and per-candidate QA; pick hands one off", async () => {
  const w = await world({ clips: ["idle", "moonwalk"] });
  const r = await cli([
    "stage",
    ...w.base,
    "--runs",
    w.runs,
    "--provider-script",
    SCRIPT,
    "--json",
  ]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const run = doc(r);
  assert.equal(run["candidates"].length, 4);
  assert.ok(run["spentUsd"] <= 5);
  const c1 = run["candidates"][0];
  assert.equal(c1.mediaType, "model/gltf-binary");
  assert.equal(c1.extension, "glb");
  const checks = Object.fromEntries(
    c1.reasons.map((x: { check: string; passed: boolean; reason: string }) => [x.check, x]),
  );
  for (const check of [
    "gltf-validator",
    "mesh-hierarchy",
    "budget-triangles",
    "budget-textureMaxPx",
    "budget-materials",
    "budget-bones",
    "budget-lods",
    "skeleton",
    "clip-idle",
    "loop-idle",
    "turntable",
  ]) {
    assert.equal(checks[check]?.passed, true, `${check}: ${checks[check]?.reason}`);
  }
  assert.match(checks["gltf-validator"].reason, /0 error/);
  assert.match(checks["clip-moonwalk"].reason, /missing, not faked/);
  assert.equal(checks["identity-lock"].shadow, true);
  assert.match(checks["identity-lock"].reason, /shadow mode, not filtered/);

  // Contract fields for the templates.
  const f = c1.fields;
  assert.deepEqual(f.clips, [{ name: "idle", durationMs: 1500, loop: true }]);
  for (const key of ["triangles", "textureMaxPx", "materials", "bones", "lods"]) {
    assert.equal(typeof f[key], "number", key);
  }
  assert.ok(Math.abs(f.bounds.min[1]) < 1e-6, "stands on the ground plane");
  assert.ok(Math.abs(f.bounds.max[1] - 0.5) < 1e-6, "scaled to heightM in metres");
  assert.ok(Math.abs(f.bounds.min[0] + f.bounds.max[0]) < 1e-6, "centred on x");

  // Provenance per candidate: calls, cost, grant.
  const p = c1.provenance;
  assert.deepEqual(
    p.calls.map((c: { operation: string }) => c.operation),
    ["model3d", "model3d-facing", "rig3d", "clip-map", "clips3d", "identity"],
  );
  assert.ok(Math.abs(p.costUsd - 0.65008) < 1e-9, `cost ${p.costUsd}`);
  assert.equal(p.outputGrant.relabel, true);
  assert.equal(p.calls[0].referenceHashes.length, 3);
  assert.deepEqual(
    p.calls[0].parameters.views.map((v: { view: string }) => v.view),
    ["front", "left", "back"],
  );
  assert.equal(p.calls[0].parameters.maxTriangles, 40000, "the triangle budget is sent");

  // Turntable renders for the person.
  const renders = await readdir(join(w.runs, run["runId"], "c1-character-3d"));
  for (const view of ["front.png", "three-quarter.png", "side.png", "back.png"]) {
    assert.ok(renders.includes(view), view);
  }
  assert.equal(renders.filter((n) => n.startsWith("clip-idle-")).length, 4);

  // The staged file is the rigged, animated glb with a single root and the family's clip name.
  const staged = new Uint8Array(await readFile(join(w.runs, run["runId"], c1.file)));
  const glb = parseGlb(staged);
  assert.equal(glb.json.scenes?.[0]?.nodes?.length, 1);
  assert.deepEqual(
    clipsOf(glb).map((c) => c.name),
    ["idle"],
  );
  // A target reads each clip's loop flag from the animation's extras, matching the manifest.
  assert.deepEqual(glb.json.animations?.[0]?.["extras"], { loop: true });
  assert.ok(measure(glb).bones > 0);

  const picked = await cli([
    "pick",
    "--run",
    join(w.runs, run["runId"]),
    "--candidate",
    "c1",
    "--target",
    w.target,
    "--json",
  ]);
  assert.equal(picked.code, 0, picked.stdout + picked.stderr);
  const out = doc(picked);
  assert.equal(out["validator"].accepted, true, out["validator"].output);
  const manifest = JSON.parse(
    await readFile(join(w.target, "characters/fern/manifest.json"), "utf8"),
  );
  assert.equal(manifest.review.status, "pending");
  assert.equal(manifest.source.mediaType, "model/gltf-binary");
  assert.equal(manifest.model.extension, "glb");
  assert.deepEqual(manifest.model.clips, [{ name: "idle", durationMs: 1500, loop: true }]);
  assert.deepEqual(manifest.semantic, { role: "actor", entity: "grove.fern" });
  const written = new Uint8Array(await readFile(join(w.target, "characters/fern/fern.glb")));
  assert.equal(readDigitalSourceType(written, "model/gltf-binary") !== undefined, true);
  const provenance = JSON.parse(
    await readFile(join(w.target, "characters/fern/fern.glb.provenance.json"), "utf8"),
  );
  assert.equal(provenance.license, "MIT");
  assert.match(provenance.outputGrant.license, /LicenseRef-tripo-paid/);
  assert.equal(provenance.outputGrant.relabel, true);
  assert.ok(provenance.requestIds.length >= 4);
  assert.ok(provenance.models.includes("tripo/v2.5-20250123"));
});

test("a family with no library clip is reported missing and the candidate is kept", async () => {
  const w = await world({ gait: "quadruped", clips: ["idle"] });
  const dry = await cli(["stage", ...w.base, "--dry-run", "--json"]);
  // The forecast is an upper bound: the family may be mapped to the one library clip.
  assert.deepEqual(
    doc(dry)["plan"].perCandidate.map((c: { operation: string }) => c.operation),
    ["model3d", "model3d-facing", "rig3d", "clips3d", "identity"],
  );
  assert.deepEqual(
    doc(dry)["plan"].perRequest.map((c: { operation: string }) => c.operation),
    ["clip-map"],
  );
  const r = await cli([
    "stage",
    ...w.base,
    "--runs",
    w.runs,
    "--provider-script",
    SCRIPT,
    "--candidates",
    "1",
    "--json",
  ]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const c1 = doc(r)["candidates"][0];
  assert.deepEqual(c1.fields.clips, []);
  assert.equal(c1.fields.missingClips[0].family, "idle");
  assert.match(c1.fields.missingClips[0].why, /no close quadruped clip/);
  assert.match(c1.fields.missingClips[0].why, /the clip-map decision answered none/);
  assert.equal(c1.provenance.calls[2].parameters.rigType, "quadruped");
});

test("a family that is not a library key is mapped by one clip-map decision per run, and a low or unreported probability keeps it missing", async () => {
  const w = await world({ clips: ["attack", "sprint", "death"] });
  const dry = await cli(["stage", ...w.base, "--dry-run", "--json"]);
  assert.deepEqual(
    doc(dry)["plan"].perRequest.map((c: { operation: string }) => c.operation),
    ["clip-map", "clip-map", "clip-map"],
  );
  const run = async (map: Record<string, unknown>, runs: string) => {
    const r = await cli(
      [
        "stage",
        ...w.base,
        "--runs",
        runs,
        "--provider-script",
        SCRIPT,
        "--candidates",
        "2",
        "--json",
      ],
      { SCRIPT_3D_CLIP_MAP: JSON.stringify(map) },
    );
    assert.equal(r.code, 0, r.stdout + r.stderr);
    return doc(r);
  };
  const out = await run(
    {
      attack: { choice: "slash", probability: 0.9 },
      sprint: { choice: "run", probability: 0.9 },
      death: { choice: "none" },
    },
    w.runs,
  );
  assert.equal(out["candidates"].length, 2);
  const decisions = (c: {
    provenance: { calls: Array<{ operation: string; requestId: string }> };
  }) => c.provenance.calls.filter((x) => x.operation === "clip-map").map((x) => x.requestId);
  // Made once per family for the run, by the first candidate; the second reuses them.
  assert.deepEqual(decisions(out["candidates"][0]), [
    "scripted-clip-map-0",
    "scripted-clip-map-1",
    "scripted-clip-map-2",
  ]);
  assert.deepEqual(decisions(out["candidates"][1]), []);
  for (const c of out["candidates"]) {
    assert.deepEqual(c.fields.clips, [
      { name: "attack", durationMs: 1500, loop: false },
      { name: "sprint", durationMs: 1500, loop: true },
    ]);
    assert.deepEqual(
      c.fields.missingClips.map((m: { family: string }) => m.family),
      ["death"],
    );
    assert.match(c.fields.missingClips[0].why, /no close biped clip for "death"/);
    assert.match(c.fields.missingClips[0].why, /the clip-map decision answered none/);
    assert.deepEqual(
      c.fields.mappedClips.map((m: { family: string; key: string; probability: number }) => [
        m.family,
        m.key,
        m.probability,
      ]),
      [
        ["attack", "slash", 0.9],
        ["sprint", "run", 0.9],
      ],
    );
  }
  const staged = parseGlb(
    new Uint8Array(await readFile(join(w.runs, out["runId"], out["candidates"][0].file))),
  );
  assert.deepEqual(
    clipsOf(staged).map((c) => c.name),
    ["attack", "sprint"],
  );

  const low = await run(
    { attack: { choice: "slash", probability: 0.3 }, sprint: { choice: "run" } },
    `${w.runs}-low`,
  );
  const c = low["candidates"][0];
  assert.deepEqual(c.fields.clips, []);
  const attack = c.fields.missingClips.find((m: { family: string }) => m.family === "attack");
  assert.match(attack.why, /chose slash with probability 0\.30, under 0\.5/);
  const sprint = c.fields.missingClips.find((m: { family: string }) => m.family === "sprint");
  assert.match(sprint.why, /chose run with no probability reported/);
  assert.equal(c.fields.mappedClips, undefined);
});

test("over budget fails with the measured value, and the rejection keeps its cost and renders", async () => {
  const w = await world(
    {},
    {
      model3d: {
        format: "glb",
        budgets: { triangles: 100, textureMaxPx: 2048, materials: 4, bones: 80, lods: 1 },
        units: "m",
        turntable: { sizePx: 64 },
      },
    },
  );
  const r = await cli([
    "stage",
    ...w.base,
    "--runs",
    w.runs,
    "--provider-script",
    SCRIPT,
    "--candidates",
    "2",
    "--json",
  ]);
  assert.equal(r.code, 5, r.stdout + r.stderr);
  const run = doc(r);
  assert.equal(run["rejections"].length, 2);
  const failed = run["rejections"][0].reasons.find(
    (x: { check: string }) => x.check === "budget-triangles",
  );
  assert.match(failed.reason, /^triangles \d+ over the budget of 100$/);
  assert.ok(run["rejections"][0].costUsd > 0);
  assert.ok(existsSync(join(w.runs, run["runId"], run["rejections"][0].artifacts[0])));
});

test("an open loop from the provider is closed for looping families", async () => {
  const w = await world();
  const r = await cli(
    [
      "stage",
      ...w.base,
      "--runs",
      w.runs,
      "--provider-script",
      SCRIPT,
      "--candidates",
      "1",
      "--json",
    ],
    { SCRIPT_3D_OPEN_LOOP: "1" },
  );
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const c1 = doc(r)["candidates"][0];
  assert.ok(c1.provenance.parameters.loopClosedChannels.idle > 0);
  const loop = c1.reasons.find((x: { check: string }) => x.check === "loop-idle");
  assert.equal(loop.passed, true, loop.reason);
});

test("a grant the target cannot accept is refused with exit 7 before anything is written", async () => {
  const w = await world();
  const meshyFree = {
    license: "CC-BY-4.0",
    plan: "free",
    commercial: true,
    relabel: false,
    attribution: "3D model generated with Meshy (meshy.ai)",
  };
  // The developer settings declare the grant of the provider and model each 3D role runs on.
  writeSettings({
    roles: {
      model3d: { provider: "scripted", model: defaultRoutes.model3d.model, outputGrant: meshyFree },
      rig3d: { provider: "scripted", model: defaultRoutes.rig3d.model, outputGrant: meshyFree },
    },
  });
  const staged = await cli([
    "stage",
    ...w.base,
    "--runs",
    w.runs,
    "--provider-script",
    SCRIPT,
    "--candidates",
    "1",
    "--json",
  ]);
  assert.equal(staged.code, 0, staged.stdout + staged.stderr);
  const runDir = join(w.runs, doc(staged)["runId"]);
  const refused = await cli([
    "pick",
    "--run",
    runDir,
    "--candidate",
    "c1",
    "--target",
    w.target,
    "--json",
  ]);
  assert.equal(refused.code, 7, refused.stdout + refused.stderr);
  assert.equal(doc(refused)["error"].code, "license_refused");
  assert.deepEqual((await readdir(w.target)).sort(), [".git", ".gitattributes"]);

  // Accepted on purpose, it ships under CC BY with the credit line.
  await writeFile(
    join(w.dir, "profile.json"),
    JSON.stringify(profile3d({ acceptedLicenses: ["CC-BY-4.0"] })),
  );
  const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  run.profile.acceptedLicenses = ["CC-BY-4.0"];
  await writeFile(join(runDir, "run.json"), JSON.stringify(run));
  const accepted = await cli([
    "pick",
    "--run",
    runDir,
    "--candidate",
    "c1",
    "--target",
    w.target,
    "--json",
  ]);
  assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
  const manifest = JSON.parse(
    await readFile(join(w.target, "characters/fern/manifest.json"), "utf8"),
  );
  assert.equal(manifest.license, "CC-BY-4.0");
  assert.equal(manifest.credit, meshyFree.attribution);
});

test("a profile without model3d, or a spec without a gait, is refused before any spend", async () => {
  const noModel = await world({}, { model3d: undefined });
  const r = await cli(["stage", ...noModel.base, "--dry-run", "--json"]);
  assert.equal(r.code, 2);
  assert.match(doc(r)["error"].message, /does not declare 3D characters/);
  const noGait = await world({ gait: "slither" });
  const g = await cli(["stage", ...noGait.base, "--dry-run", "--json"]);
  assert.equal(g.code, 2);
  assert.match(doc(g)["error"].message, /gait quadruped or biped/);
});
