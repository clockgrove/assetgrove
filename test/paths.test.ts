import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { InputError } from "../src/errors.ts";
import {
  ioPath,
  readRecordPath,
  recordPath,
  recordRelative,
  refuseCaseCollisions,
} from "../src/paths.ts";
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";
import type { World } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc = (r: Result): Record<string, any> => JSON.parse(r.stdout);

/** Writes the world's spec, bible and profile beside it; returns the stage arguments. */
async function inputs(world: World, runsDir: string): Promise<string[]> {
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  return ["--spec", spec, "--bible", bible, "--profile", profile, "--runs", runsDir];
}

async function stageOne(args: string[]): Promise<string> {
  const r = await cli([
    "stage",
    ...args,
    "--candidates",
    "1",
    "--provider-script",
    passingScript,
    "--json",
  ]);
  assert.equal(r.code, 0, r.stderr);
  return doc(r)["runDir"] as string;
}

/** Every file and directory under `dir`, relative to it. */
async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(ioPath(dir), { recursive: true });
  return entries.map((entry) => entry.toString());
}

function assertSlashes(path: string): void {
  assert.ok(!path.includes("\\"), `"${path}" holds a backslash`);
}

test("recordPath and recordRelative write '/' separators", () => {
  assert.equal(recordPath("a\\b/c\\d.png"), "a/b/c/d.png");
  assert.equal(recordRelative(root, join(root, "a", "b", "c.json")), "a/b/c.json");
});

test("readRecordPath accepts '/'-separated relative paths only", () => {
  assert.equal(readRecordPath("c1-image/frame.png"), "c1-image/frame.png");
  for (const bad of ["", "c1\\frame.png", "/abs/x.png", "C:/x.png", "../x.png", "a/../../x.png"]) {
    assert.throws(() => readRecordPath(bad), InputError, bad);
  }
});

test("refuseCaseCollisions refuses paths that differ only by case", () => {
  refuseCaseCollisions(["a/b.png", "a/c.png", "a/b.png"]);
  assert.throws(() => refuseCaseCollisions(["Assets/a.png", "assets/A.png"]), InputError);
  assert.throws(() => refuseCaseCollisions(["assets\\a.png", "assets/A.png"]), InputError);
});

test("two writes differing only by case exit 2 invalid_input with nothing written", async () => {
  const world = await syntheticWorld();
  // The provenance file differs from the manifest only by the case of one directory.
  world.profile.layout.provenance =
    "assets/Manifests/{{spec.assetId}}/{{spec.animationFamily}}.json";
  delete world.profile.validator;
  const runDir = await stageOne(await inputs(world, world.runsDir));
  const r = await cli([
    "pick",
    "--run",
    runDir,
    "--candidate",
    "c1",
    "--target",
    world.targetDir,
    "--json",
  ]);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(doc(r)["error"].code, "invalid_input");
  assert.match(doc(r)["error"].message, /differ only by case/);
  assert.deepEqual(await walk(world.targetDir), []);
  const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  assert.equal(run.picked, undefined);
});

test("stage and pick into a target whose path exceeds 260 characters succeed and the records hold '/' separators", async () => {
  const world = await syntheticWorld();
  // A Windows process cannot start in a directory this deep, so the target's validator is left out:
  // this checks Assetgrove's own file I/O.
  delete world.profile.validator;
  let deep = world.dir;
  for (let i = 0; deep.length <= 300; i++) deep = join(deep, `long-segment-${i}-${"x".repeat(40)}`);
  const runsDir = join(deep, "runs");
  const targetDir = join(deep, "target");
  assert.ok(targetDir.length > 260);
  await mkdir(ioPath(targetDir), { recursive: true });

  const runDir = await stageOne(await inputs(world, runsDir));
  assert.ok(runDir.length > 260);
  const r = await cli([
    "pick",
    "--run",
    runDir,
    "--candidate",
    "c1",
    "--target",
    targetDir,
    "--json",
  ]);
  assert.equal(r.code, 0, r.stderr);

  const run = JSON.parse(await readFile(ioPath(join(runDir, "run.json")), "utf8"));
  for (const candidate of run.candidates) {
    assertSlashes(candidate.file);
    for (const artifact of candidate.artifacts ?? []) assertSlashes(artifact);
    for (const sidecar of candidate.sidecars ?? []) assertSlashes(sidecar.file);
  }
  assert.deepEqual(run.picked.files, [
    "assets/source/fern/shelter.png",
    "assets/manifests/fern/shelter.json",
  ]);
  const written = (await walk(targetDir)).map((p) => p.replaceAll("\\", "/"));
  for (const file of run.picked.files) assert.ok(written.includes(file), file);
  const manifest = JSON.parse(
    await readFile(ioPath(join(targetDir, "assets/manifests/fern/shelter.json")), "utf8"),
  );
  assert.equal(manifest.source.path, "assets/source/fern/shelter.png");
});

test("a stage run writes no path segment containing ':'", async () => {
  const world = await syntheticWorld();
  const runDir = await stageOne(await inputs(world, world.runsDir));
  const paths = [relative(world.runsDir, runDir), ...(await walk(world.runsDir))];
  assert.ok(paths.length > 1);
  for (const path of paths) {
    for (const segment of path.split(/[\\/]/)) assert.ok(!segment.includes(":"), path);
  }
});
