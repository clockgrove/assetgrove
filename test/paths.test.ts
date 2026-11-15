import "./fixtures/env.ts";
import { approve, approveProfile } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { InputError } from "../src/errors.ts";
import { scriptedProvider } from "./fixtures/synthetic.ts";
import type { Generator } from "../src/generators/generator.ts";
import { imageGenerators } from "../src/generators/image.ts";
import { stage } from "../src/loop.ts";
import { defaultRoutes } from "../src/routes.ts";
import { checkWrites, readRecordPath, recordPath } from "../src/paths.ts";
import { shelterSpec, syntheticWorld as plainWorld } from "./fixtures/synthetic.ts";
import type { World } from "./fixtures/synthetic.ts";

async function syntheticWorld(): Promise<World> {
  const world = await plainWorld();
  approveProfile(world.profile, { targetDir: world.targetDir });
  return world;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
approve(passingScript);

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
      { cwd: root, env: process.env },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function doc(result: Result): Record<string, any> {
  return JSON.parse(result.stdout);
}

/** Every file and directory under `dir`, relative to it. */
async function tree(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).map((entry) => entry.toString());
}

/** Writes the world's inputs and stages one candidate through the CLI into `runsDir`. */
async function stageOne(world: World, runsDir = world.runsDir): Promise<string> {
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  const r = await cli([
    "stage",
    "--spec",
    spec,
    "--bible",
    bible,
    "--profile",
    profile,
    "--runs",
    runsDir,
    "--candidates",
    "1",
    "--provider-script",
    passingScript,
    "--json",
  ]);
  assert.equal(r.code, 0, r.stderr);
  return doc(r)["runDir"] as string;
}

function pick(runDir: string, targetDir: string): Promise<Result> {
  return cli(["pick", "--run", runDir, "--candidate", "c1", "--target", targetDir, "--json"]);
}

test("record paths use / on every OS, and readers refuse \\", () => {
  assert.equal(recordPath(join("assets", "source", "fern.png")), "assets/source/fern.png");
  assert.equal(readRecordPath("c1-still/turntable.png"), "c1-still/turntable.png");
  assert.throws(() => readRecordPath("c1-still\\turntable.png"), InputError);
});

test("checkWrites refuses case-only collisions and ':' segments, and passes distinct paths", () => {
  checkWrites(["assets/a.png", "assets/b.png", "assets/a.png.provenance.json"]);
  assert.throws(() => checkWrites(["assets/Fern.png", "assets/fern.png"]), /differ only by case/);
  assert.throws(() => checkWrites(["Assets/fern.png", "assets/fern.png"]), InputError);
  assert.throws(() => checkWrites(["assets/12:00.png"]), /":"/);
});

test("two writes differing only by case exit 2 invalid_input with nothing written", async () => {
  const world = await syntheticWorld();
  world.profile.layout = {
    ...world.profile.layout,
    // The clash appears only once the output's extension is known, at the pick.
    media: "assets/source/{{spec.assetId}}/{{spec.animationFamily}}.{{output.extension}}",
    provenance: "assets/source/{{spec.assetId}}/Shelter.png",
  };
  const runDir = await stageOne(world);
  const r = await pick(runDir, world.targetDir);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(doc(r)["error"].code, "invalid_input");
  assert.match(doc(r)["error"].message, /differ only by case/);
  assert.deepEqual(await tree(world.targetDir), []);
});

test("a hand-off path segment with ':' exits 2 invalid_input with nothing written", async () => {
  const world = await syntheticWorld();
  world.profile.layout = {
    ...world.profile.layout,
    media: "assets/{{run.pickedAt}}/{{spec.animationFamily}}.{{output.extension}}",
  };
  const runDir = await stageOne(world);
  const r = await pick(runDir, world.targetDir);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(doc(r)["error"].code, "invalid_input");
  assert.deepEqual(await tree(world.targetDir), []);
});

test("stage and pick into a target whose path exceeds 260 characters succeed, and the records hold /", async () => {
  const world = await syntheticWorld();
  // The target's validator is its own process, which Windows cannot start in a long directory.
  delete world.profile.validator;
  const deep = join(world.dir, ...Array.from({ length: 6 }, (_, i) => `${i}`.repeat(50)));
  const runsDir = join(deep, "runs");
  const targetDir = join(deep, "target");
  assert.ok(runsDir.length > 260 && targetDir.length > 260);
  await mkdir(targetDir, { recursive: true });

  const runDir = await stageOne(world, runsDir);
  assert.ok(runDir.length > 260);
  const r = await pick(runDir, targetDir);
  assert.equal(r.code, 0, r.stderr);
  const picked = doc(r);
  assert.equal(picked.ok, true);
  await readFile(picked["mediaPath"]);
  await readFile(picked["manifestPath"]);

  const record = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  const files: string[] = record.picked.files;
  assert.deepEqual(files, ["assets/source/fern/shelter.png", "assets/manifests/fern/shelter.json"]);
  for (const c of record.candidates) assert.ok(!c.file.includes("\\"), c.file);
  const manifest = JSON.parse(await readFile(picked["manifestPath"], "utf8"));
  assert.equal(manifest.source.path, "assets/source/fern/shelter.png");
});

test("a stage run writes no path segment containing ':'", async () => {
  const world = await syntheticWorld();
  await stageOne(world);
  const written = await tree(world.runsDir);
  assert.ok(written.some((path) => path.endsWith("run.json")));
  for (const path of written) {
    for (const segment of path.split(/[\\/]/)) assert.ok(!segment.includes(":"), path);
  }
});

test("staged and rejected candidates record their artifacts with / separators", async () => {
  const world = await syntheticWorld();
  const base = imageGenerators.find((g) => g.kind === shelterSpec.kind) as Generator;
  const withArtifacts: Generator = {
    ...base,
    async generate(input) {
      const generated = await base.generate(input);
      return {
        ...generated,
        // The second candidate fails QA, so its artifacts land in the rejections.
        qa: input.index === 0 ? generated.qa : { ...generated.qa, passed: false },
        artifacts: [
          { name: "sheet.png", bytes: new Uint8Array([1]) },
          { name: join("qa", "report.json"), bytes: new Uint8Array([2]) },
        ],
      };
    },
  };
  const { run, runDir } = await stage({
    spec: shelterSpec,
    specDir: world.dir,
    bible: world.bible,
    bibleDir: world.bibleDir,
    profile: world.profile,
    routes: defaultRoutes,
    provider: scriptedProvider(),
    providerName: "scripted",
    generators: [withArtifacts],
    runsDir: world.runsDir,
    candidates: 2,
  });
  const kind = shelterSpec.kind;
  const record = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  assert.deepEqual(record.candidates[0].artifacts, [
    `c1-${kind}/sheet.png`,
    `c1-${kind}/report.json`,
  ]);
  assert.deepEqual(record.rejections[0].artifacts, [
    `c2-${kind}/sheet.png`,
    `c2-${kind}/report.json`,
  ]);
  assert.deepEqual(run.candidates[0]?.artifacts, record.candidates[0].artifacts);
  await readFile(join(runDir, `c1-${kind}`, "report.json"));
});
