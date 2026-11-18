import "./fixtures/env.ts";
import { gitTarget } from "./fixtures/git.ts";
import { approve, approveProfile } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { failureOutcome } from "../src/commands/result.ts";
import { writeToTarget } from "../src/handoff.ts";
import type { TargetWrite } from "../src/handoff.ts";
import { PRESETS } from "../src/handoff/presets/index.ts";
import type { HandoffPreset, PresetRegistry } from "../src/handoff/presets/index.ts";
import { createRaster, encodePng } from "../src/image/raster.ts";
import { DIGITAL_SOURCE_TYPES } from "../src/metadata.ts";
import type { Provenance, TargetProfile } from "../src/types.ts";
import {
  shelterSpec,
  syntheticProfile,
  syntheticWorld,
  writeStyleBible,
} from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
approve(passingScript);

const COUNT = 4;
const W = 16;
const H = 8;
const STRIP = encodePng(createRaster(W * COUNT, H));

const provenance: Provenance = {
  digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
  generator: "sprite-strip",
  route: "scripted",
  models: ["scripted"],
  prompt: "a grey fox",
  parameters: {},
  requestIds: [],
  referenceHashes: [],
  bibleVersion: "synthetic-1",
  license: "MIT",
  providerTerms: [],
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:01.000Z",
  costUsd: 0,
  calls: [],
};

function stripWrite(targetDir: string, handoff: TargetProfile["handoff"]): TargetWrite {
  const profile = syntheticProfile({ handoff });
  delete profile.validator;
  return {
    profile,
    spec: shelterSpec,
    bibleVersion: "v1",
    output: {
      bytes: STRIP,
      mediaType: "image/png",
      extension: "png",
      fields: { frames: { width: W, height: H, count: COUNT, durationMs: 120 } },
    },
    provenance,
    run: { runId: "r1", candidateId: "c1", pickedAt: "2026-01-01T00:00:02.000Z" },
    targetDir,
  };
}

const dir = () => mkdtemp(join(tmpdir(), "assetgrove-atlas-"));
const MEDIA = "assets/source/fern/shelter.png";
const names = Array.from({ length: COUNT }, (_, i) => `fern_${String(i).padStart(3, "0")}`);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = any;
const frameList = (doc: Doc): Doc[] =>
  Array.isArray(doc.frames) ? doc.frames : Object.values(doc.frames);

test("hash and array outputs pass the checks; the animation and frameTags cover 0 to count-1", async () => {
  for (const [preset, shape, file] of [
    ["atlas-json", "hash", "shelter.atlas.json"],
    ["atlas-json", "array", "shelter.atlas.json"],
    ["aseprite-json", "hash", "shelter.aseprite.json"],
    ["aseprite-json", "array", "shelter.aseprite.json"],
  ] as const) {
    const target = await dir();
    const r = await writeToTarget(stripWrite(target, [{ preset, options: { shape } }]));
    assert.deepEqual(r.handoff[0]!.files, [`assets/source/fern/${file}`]);
    const doc: Doc = JSON.parse(await readFile(join(target, "assets/source/fern", file), "utf8"));
    assert.equal(Array.isArray(doc.frames), shape === "array");
    assert.equal(frameList(doc).length, COUNT);
    if (shape === "hash") assert.deepEqual(Object.keys(doc.frames), names);
    assert.deepEqual(doc.meta.size, { w: W * COUNT, h: H });
    assert.equal(doc.meta.scale, "1");
    assert.equal(doc.meta.image, "shelter.png");
    frameList(doc).forEach((f, i) => assert.deepEqual(f.frame, { x: i * W, y: 0, w: W, h: H }));
    if (preset === "atlas-json") assert.deepEqual(doc.animations, { shelter: names });
    else {
      assert.deepEqual(doc.meta.frameTags, [
        { name: "shelter", from: 0, to: COUNT - 1, direction: "forward" },
      ]);
      assert.ok(frameList(doc).every((f) => f.duration === 120));
    }
  }
  // The default shapes: hash for atlas-json, array for aseprite-json.
  const target = await dir();
  await writeToTarget(stripWrite(target, [{ preset: "atlas-json" }, { preset: "aseprite-json" }]));
  const a: Doc = JSON.parse(
    await readFile(join(target, "assets/source/fern/shelter.atlas.json"), "utf8"),
  );
  const b: Doc = JSON.parse(
    await readFile(join(target, "assets/source/fern/shelter.aseprite.json"), "utf8"),
  );
  assert.equal(Array.isArray(a.frames), false);
  assert.equal(Array.isArray(b.frames), true);
});

/** A registry whose atlas presets write the document `corrupt` has changed. */
function corrupting(corrupt: (doc: Doc) => Doc): PresetRegistry {
  const presets = new Map(PRESETS);
  for (const name of ["atlas-json", "aseprite-json"]) {
    const real = PRESETS.get(name) as HandoffPreset;
    presets.set(name, {
      ...real,
      write: (ctx, options) =>
        real.write(ctx, options).map((f) => ({
          ...f,
          content: JSON.stringify(corrupt(JSON.parse(f.content as string))),
        })),
    });
  }
  return { presets };
}

const CORRUPTIONS: Array<[string, (doc: Doc) => Doc, RegExp]> = [
  [
    "shape",
    (d) => ({
      ...d,
      frames: Array.isArray(d.frames)
        ? Object.fromEntries(d.frames.map((f: Doc) => [f.filename, f]))
        : Object.values(d.frames),
    }),
    /frames is not/,
  ],
  ["size", (d) => ({ ...d, meta: { ...d.meta, size: { w: 1, h: 1 } } }), /meta\.size/],
  [
    "a rectangle",
    (d) => {
      frameList(d)[1]!.frame.x += 1;
      return d;
    },
    /rectangle/,
  ],
  [
    "frame count",
    (d) => {
      if (Array.isArray(d.frames)) d.frames.pop();
      else delete d.frames[Object.keys(d.frames).at(-1)!];
      return d;
    },
    /lists 3 frames/,
  ],
  ["image path", (d) => ({ ...d, meta: { ...d.meta, image: "missing.png" } }), /meta\.image/],
  [
    "missing meta",
    (d) => {
      delete d.meta;
      return d;
    },
    /meta\.size/,
  ],
  ["null meta", (d) => ({ ...d, meta: null }), /meta\.size/],
  [
    "absolute image path",
    (d) => ({ ...d, meta: { ...d.meta, image: "/shelter.png" } }),
    /meta\.image/,
  ],
  [
    "tag past the last frame",
    (d) => {
      if (d.meta.frameTags) d.meta.frameTags[0].to = COUNT + 5;
      else d.animations.shelter.pop();
      return d;
    },
    /frameTags|animations/,
  ],
  [
    "tag coverage",
    (d) => {
      if (d.meta.frameTags) d.meta.frameTags[0].to = COUNT - 2;
      else d.animations.shelter.pop();
      return d;
    },
    /frameTags|animations/,
  ],
  [
    "missing animations",
    (d) => {
      delete d.animations;
      return d;
    },
    /animations/,
  ],
  [
    "renamed animation",
    (d) => ({ ...d, animations: { renamed: d.animations.shelter } }),
    /animations/,
  ],
  [
    "dropped animation frame",
    (d) => {
      d.animations.shelter.splice(1, 1);
      return d;
    },
    /animations\.shelter/,
  ],
];

test("corrupting each checked field exits 6 handoff_check_failed", async () => {
  for (const preset of ["atlas-json", "aseprite-json"]) {
    for (const shape of ["hash", "array"]) {
      for (const [field, corrupt, message] of CORRUPTIONS) {
        const write = {
          ...stripWrite(await dir(), [{ preset, options: { shape } }]),
          registry: corrupting(corrupt),
        };
        const error = await writeToTarget(write).then(
          () => undefined,
          (e: unknown) => e,
        );
        assert.ok(error, `${preset} ${shape}: corrupting ${field} must fail`);
        const outcome = failureOutcome(error);
        assert.equal(outcome.exitCode, 6, `${preset} ${shape} ${field}`);
        assert.equal(outcome.error?.code, "handoff_check_failed");
        assert.ok(
          (error as { problems: Array<{ problem: string }> }).problems.some((p) =>
            message.test(p.problem),
          ),
          `${preset} ${shape} ${field}: ${JSON.stringify((error as { problems: unknown }).problems)}`,
        );
      }
    }
  }
  // A missing PNG fails the image check too.
  const target = await dir();
  const real = PRESETS.get("atlas-json") as HandoffPreset;
  const registry: PresetRegistry = {
    presets: new Map([
      ...PRESETS,
      [
        "atlas-json",
        {
          ...real,
          check: async (c, o, f, read) =>
            real.check(c, o, f, (p) => read(p === MEDIA ? "gone.png" : p)),
        },
      ],
    ]),
  };
  await assert.rejects(
    writeToTarget({ ...stripWrite(target, [{ preset: "atlas-json" }]), registry }),
    { code: "handoff_check_failed" },
  );
});

test("a profile selecting atlas-json hands off a sprite-strip pick with the scripted provider", async () => {
  const world = await syntheticWorld();
  delete world.profile.validator;
  world.profile.handoff = [{ preset: "atlas-json", options: { shape: "array" } }];
  approveProfile(world.profile, { targetDir: world.targetDir });
  gitTarget(world.targetDir);
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "BIBLE.md");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeStyleBible(bible, world.bible);
  await writeFile(profile, JSON.stringify(world.profile));
  const cli = (args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(
        process.execPath,
        ["src/cli.ts", ...args],
        { cwd: root, env: process.env },
        (error, stdout, stderr) =>
          resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
      );
      child.stdin?.end();
    });
  const staged = await cli([
    "stage",
    "--spec",
    spec,
    "--bible",
    bible,
    "--profile",
    profile,
    "--runs",
    world.runsDir,
    "--candidates",
    "1",
    "--provider-script",
    passingScript,
    "--json",
  ]);
  assert.equal(staged.code, 0, staged.stderr);
  const runDir = JSON.parse(staged.stdout).runDir as string;
  const picked = await cli([
    "pick",
    "--run",
    runDir,
    "--candidate",
    "c1",
    "--target",
    world.targetDir,
    "--json",
  ]);
  assert.equal(picked.code, 0, picked.stderr);
  const out = JSON.parse(picked.stdout);
  assert.deepEqual(out.handoff, [
    { preset: "atlas-json", files: [`assets/source/fern/shelter.atlas.json`] },
  ]);
  const doc: Doc = JSON.parse(
    await readFile(join(world.targetDir, "assets/source/fern/shelter.atlas.json"), "utf8"),
  );
  assert.equal(doc.frames.length, shelterSpec.frames!.count);
  assert.deepEqual(doc.animations.shelter.length, shelterSpec.frames!.count);
});

test("a layout with ./ or .. inside a file name hands off", async () => {
  for (const media of ["./assets/walk.png", "assets/walk..png"]) {
    for (const preset of ["atlas-json", "aseprite-json"]) {
      const target = await dir();
      const write = stripWrite(target, [{ preset }]);
      write.profile.layout.media = media;
      const r = await writeToTarget(write);
      assert.equal(r.handoff[0]!.files.length, 1, `${preset} ${media}`);
    }
  }
});

test("a still is refused by both presets before anything is written", async () => {
  for (const preset of ["atlas-json", "aseprite-json"]) {
    const target = await dir();
    const write = stripWrite(target, [{ preset }]);
    write.spec = { ...shelterSpec, kind: "still" } as typeof shelterSpec;
    write.output.fields = { frames: { width: W, height: H, count: 1 } };
    await assert.rejects(writeToTarget(write), (e) => failureOutcome(e).exitCode === 2);
    await assert.rejects(readFile(join(target, "assets/source/fern/shelter.png")));
  }
});
