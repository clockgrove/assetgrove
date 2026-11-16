import "./fixtures/env.ts";
import { gitTarget } from "./fixtures/git.ts";
import { approve, approveProfile } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodePng } from "../src/image/raster.ts";
import { parseGlb } from "../src/model3d/glb.ts";
import { InputError } from "../src/errors.ts";
import { appendAnimation, clips as clipsOf, samplePose } from "../src/model3d/scene.ts";
import { syntheticCharacter } from "./fixtures/glb.ts";
import { PALETTE, drawSubject } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const VALIDATOR = fileURLToPath(new URL("./fixtures/validator-3d.ts", import.meta.url));
const BASE_SCRIPT = pathToFileURL(
  fileURLToPath(new URL("./fixtures/model3d-script.ts", import.meta.url)),
).href;
const GLB_FIXTURE = pathToFileURL(
  fileURLToPath(new URL("./fixtures/glb.ts", import.meta.url)),
).href;

/** Durations of the library clips, so a delivered clip can be told from the bind take. */
const SCRIPT = `
import base from ${JSON.stringify(BASE_SCRIPT)};
import { syntheticCharacter } from ${JSON.stringify(GLB_FIXTURE)};
const seconds = { "preset:walk": 1.5, "preset:run": 1 };
const mode = process.env["CLIPS_MODE"];
export default {
  ...base,
  animate(request, index) {
    const clip = request.clips[0];
    if (request.clips.length !== 1) throw new Error("one clip per call");
    const take = { name: mode === "blend" ? "walk_run_blend" : "Armature|Take 001", durationS: seconds[clip], loopClosed: true };
    const clips = mode === "blend" ? [take] : [{ name: "Animation_0", durationS: 0.5, loopClosed: true }, take];
    return {
      handle: "clips-" + index,
      glb: syntheticCharacter({ triangles: 300, joints: 3, clips }),
      costUsd: 0.1,
      ...(mode === "mapped" && { animations: { [clip]: 1 } }),
    };
  },
};
`;

function cli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
  const merged = { ...process.env, ...env };
  delete merged["AI_GATEWAY_API_KEY"];
  delete merged["TRIPO_API_KEY"];
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env: merged },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, out: stdout, err: stderr }),
    );
  });
}

async function stage(mode: string) {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-clips-"));
  const script = join(dir, "script.ts");
  await writeFile(script, SCRIPT);
  approve(script);
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
  const profile = {
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
      review: { status: "pending" },
      model: { extension: "{{output.extension}}", clips: "{{output.clips}}" },
      contentHash: "{{output.sha256}}",
    },
    review: { path: "review.status", pending: "pending" },
    validator: { command: [process.execPath, VALIDATOR, "{{manifest}}"] },
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
      clips: ["walk", "run"],
      heightM: 0.5,
    }),
  );
  await writeFile(files.bible, JSON.stringify(bible));
  await writeFile(files.profile, JSON.stringify(profile));
  const target = join(dir, "target");
  gitTarget(target);
  approveProfile(profile, { targetDir: target });
  const r = await cli(
    [
      "stage",
      "--spec",
      files.spec,
      "--bible",
      files.bible,
      "--profile",
      files.profile,
      "--runs",
      join(dir, "runs"),
      "--provider-script",
      script,
      "--candidates",
      "1",
      "--json",
    ],
    { CLIPS_MODE: mode },
  );
  assert.ok(r.out.startsWith("{"), r.out + r.err);
  const run = JSON.parse(r.out);
  const candidate = run["candidates"][0] ?? run["rejections"][0];
  const checks = Object.fromEntries(
    candidate.reasons.map((x: { check: string; passed: boolean; reason: string }) => [x.check, x]),
  );
  return { candidate, checks };
}

test("an extra bind take and generic names do not matter when the adapter says which animation is the clip", async () => {
  const { candidate, checks } = await stage("mapped");
  assert.deepEqual(candidate.fields.clips, [
    { name: "walk", durationMs: 1500, loop: true },
    { name: "run", durationMs: 1000, loop: true },
  ]);
  for (const check of ["clip-walk", "clip-run", "loop-walk", "loop-run"]) {
    assert.equal(checks[check]?.passed, true, `${check}: ${checks[check]?.reason}`);
  }
  assert.equal(candidate.fields.unmatchedClips, undefined);
  assert.deepEqual(
    candidate.provenance.calls.map((c: { operation: string }) => c.operation).slice(0, 4),
    ["model3d", "rig3d", "clips3d", "clips3d"],
  );
});

test("without a mapping, two animations in a result leave the family unmatched and its check fails", async () => {
  const { checks } = await stage("unmapped");
  for (const family of ["walk", "run"]) {
    assert.match(
      checks[`clip-${family}`].reason,
      new RegExp(
        `the provider returned 2 animations for library clip preset:${family} and did not say which is the clip`,
      ),
    );
  }
  for (const check of ["clip-walk", "clip-run"]) assert.equal(checks[check]?.passed, false, check);
});

test("an animation named for another family is labelled by the clip that was asked for, never by its name", async () => {
  const { candidate, checks } = await stage("blend");
  assert.deepEqual(candidate.fields.clips, [
    { name: "walk", durationMs: 1500, loop: true },
    { name: "run", durationMs: 1000, loop: true },
  ]);
  for (const check of ["clip-walk", "clip-run"]) assert.equal(checks[check]?.passed, true, check);
});

test("appendAnimation keeps keyframe values and maps nodes by name", () => {
  const base = parseGlb(
    syntheticCharacter({
      joints: 3,
      clips: [{ name: "a", durationS: 1, loopClosed: true }],
    }),
  );
  const from = parseGlb(
    syntheticCharacter({
      joints: 3,
      clips: [{ name: "b", durationS: 2, loopClosed: false }],
    }),
  );
  // In `from` the first two joints trade places, so index and name disagree.
  const [n1, n2] = [from.json.nodes![1]!, from.json.nodes![2]!];
  [n1.name, n2.name] = [n2.name, n1.name];
  const before = base.bin.byteLength;
  appendAnimation(base, from, 0);
  assert.equal(base.bin.byteLength % 4, 0);
  assert.ok(base.bin.byteLength > before);
  assert.deepEqual(
    clipsOf(base).map((c) => [c.name, c.durationS]),
    [
      ["a", 1],
      ["b", 2],
    ],
  );
  const targets = base.json.animations![1]!.channels.map((c) => c.target.node);
  assert.deepEqual(targets, [2, 1, 3]);
  const input = base.json.animations![1]!.samplers[0]!.input;
  assert.deepEqual(base.json.accessors![input]!.max, [2]);
  const appended = samplePose(base, 1, 2);
  const original = samplePose(from, 0, 2);
  assert.deepEqual(
    appended.get(2)!.r.map((v) => Math.round(v * 1e5)),
    original.get(1)!.r.map((v) => Math.round(v * 1e5)),
  );
});

test("appendAnimation refuses a node the base does not have and leaves the base as it was", () => {
  const base = parseGlb(
    syntheticCharacter({ joints: 3, clips: [{ name: "a", durationS: 1, loopClosed: true }] }),
  );
  const from = parseGlb(
    syntheticCharacter({ joints: 3, clips: [{ name: "b", durationS: 2, loopClosed: true }] }),
  );
  from.json.nodes![2]!.name = "elbow";
  const before = base.bin.byteLength;
  assert.throws(
    () => appendAnimation(base, from, 0),
    (e) => e instanceof InputError && /animates node "elbow"/.test(e.message),
  );
  assert.equal(base.bin.byteLength, before);
  assert.equal(base.json.animations!.length, 1);
});
