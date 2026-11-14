import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { InputError } from "../src/errors.ts";
import { checkWriteSet, recordPath, relativeRecordPath } from "../src/paths.ts";
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
  const env = { ...process.env };
  delete env["AI_GATEWAY_API_KEY"];
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

/** Every file and directory under `dir`, relative to it, '/'-separated. */
async function tree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map((entry) => recordPath(entry)).sort();
}

/** Writes the world's inputs and stages one candidate into `runsDir`. */
async function stageOne(world: World, runsDir: string): Promise<Record<string, unknown>> {
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  const r = await cli([
    "stage",
    ...["--spec", spec, "--bible", bible, "--profile", profile, "--runs", runsDir],
    ...["--candidates", "1", "--provider-script", passingScript, "--json"],
  ]);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

function pick(runDir: string, targetDir: string): Promise<Result> {
  return cli(["pick", "--run", runDir, "--candidate", "c1", "--target", targetDir, "--json"]);
}

test("record paths use '/' whatever the OS separator is", () => {
  assert.equal(recordPath(["a", "b", "c.png"].join(sep)), "a/b/c.png");
  assert.equal(relativeRecordPath(join("x", "t"), join("x", "t", "a", "b.json")), "a/b.json");
});

test("a write set refuses case-only collisions and ':' in a name, before anything is written", () => {
  assert.throws(() => checkWriteSet("t", ["a/Fern.png", "a/fern.png"]), InputError);
  const rootDir = resolve("t");
  assert.throws(
    () => checkWriteSet(rootDir, [join(rootDir, "a", "B.json"), "a/b.json"]),
    InputError,
  );
  assert.throws(() => checkWriteSet("t", ["runs/12:00.png"]), InputError);
  // The root itself is not checked (a Windows drive has ':'); only the written segments are.
  assert.doesNotThrow(() => checkWriteSet(rootDir, [join(rootDir, "a", "b.png"), "a/c.png"]));
  assert.doesNotThrow(() => checkWriteSet("t", ["a/b.png", "a/b.png.provenance.json"]));
});

test("two writes differing only by case exit 2 invalid_input with nothing written", async () => {
  const world = await syntheticWorld();
  // The media and its provenance record differ only by case.
  world.profile.layout = {
    media: "assets/{{spec.assetId}}.{{output.extension}}",
    manifest: "assets/{{spec.assetId}}.json",
    provenance: "assets/{{spec.assetId}}.PNG",
  };
  const staged = await stageOne(world, world.runsDir);
  const r = await pick(staged["runDir"] as string, world.targetDir);
  assert.equal(r.code, 2, r.stderr);
  const doc = JSON.parse(r.stdout) as { ok: boolean; error: { code: string; message: string } };
  assert.equal(doc.ok, false);
  assert.equal(doc.error.code, "invalid_input");
  assert.match(doc.error.message, /differ only by case/);
  assert.deepEqual(await tree(world.targetDir), []);
  // The run records no pick either.
  const run = JSON.parse(await readFile(join(staged["runDir"] as string, "run.json"), "utf8"));
  assert.equal(run.picked, undefined);
});

test("stage and pick into a target whose path exceeds 260 characters, with '/' records", async () => {
  const world = await syntheticWorld();
  // A validator is a child process, not Assetgrove's own file I/O; this profile has none.
  delete world.profile.validator;
  let deep = world.dir;
  for (let i = 0; deep.length <= 300; i++) deep = join(deep, `long-segment-${i}-${"x".repeat(40)}`);
  const runsDir = join(deep, "runs");
  const targetDir = join(deep, "target");
  await mkdir(targetDir, { recursive: true });
  assert.ok(targetDir.length > 260);

  const staged = await stageOne(world, runsDir);
  const runDir = staged["runDir"] as string;
  assert.ok(runDir.length > 260);
  const r = await pick(runDir, targetDir);
  assert.equal(r.code, 0, r.stderr);

  const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  const files = run.picked.files as string[];
  assert.deepEqual(files, ["assets/source/fern/shelter.png", "assets/manifests/fern/shelter.json"]);
  for (const file of [...files, run.candidates[0].file]) assert.ok(!file.includes("\\"), file);
  const manifest = JSON.parse(
    await readFile(join(targetDir, "assets/manifests/fern/shelter.json"), "utf8"),
  );
  assert.equal(manifest.source.path, "assets/source/fern/shelter.png");
  assert.deepEqual(
    (await tree(targetDir)).filter((p) => p.includes(".")),
    [...files].sort(),
  );
});

test("a stage run writes no path segment containing ':'", async () => {
  const world = await syntheticWorld();
  const staged = await stageOne(world, world.runsDir);
  const written = await tree(world.runsDir);
  assert.ok(written.some((p) => p.endsWith("run.json")));
  assert.ok((staged["runDir"] as string).startsWith(world.runsDir));
  for (const path of written) {
    for (const segment of path.split("/")) assert.ok(!segment.includes(":"), path);
  }
});
