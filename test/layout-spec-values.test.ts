import "./fixtures/env.ts";
import { approve, approveProfile } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkSpecValues } from "../src/paths.ts";
import type { AssetSpec, TargetProfile } from "../src/types.ts";
import { gitTarget } from "./fixtures/git.ts";
import { shelterSpec, syntheticProfile, syntheticWorld } from "./fixtures/synthetic.ts";

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

const stillSpec = { kind: "still", assetId: "fern", subject: "icon" } as unknown as AssetSpec;

/** A provider script that records every call it is asked to answer in `calls`. */
async function recordingScript(dir: string): Promise<{ script: string; calls: string }> {
  const calls = join(dir, "calls.log");
  const script = join(dir, "recording-script.mjs");
  const record = (name: string) =>
    `${name}: () => { appendFileSync(${JSON.stringify(calls)}, "${name}\\n"); throw new Error("no paid call expected"); }`;
  await writeFile(
    script,
    `import { appendFileSync } from "node:fs";\nexport default { ${["image", "vision", "decide"].map(record).join(", ")} };\n`,
  );
  approve(script);
  return { script, calls };
}

async function writeInputs(world: Awaited<ReturnType<typeof syntheticWorld>>, spec: AssetSpec) {
  const specPath = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(specPath, JSON.stringify(spec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  return { specPath, bible, profile };
}

async function stage(
  world: Awaited<ReturnType<typeof syntheticWorld>>,
  spec: AssetSpec,
  script = passingScript,
  extra: string[] = [],
): Promise<Result> {
  const { specPath, bible, profile } = await writeInputs(world, spec);
  return cli([
    "stage",
    ...["--spec", specPath, "--bible", bible, "--profile", profile],
    ...["--runs", world.runsDir, "--candidates", "1"],
    ...["--provider-script", script, ...extra, "--json"],
  ]);
}

function pick(runDir: string, targetDir: string): Promise<Result> {
  return cli(["pick", "--run", runDir, "--candidate", "c1", "--target", targetDir, "--json"]);
}

/** The profile `init --profile-preset sprite-32` writes, as a world's profile. */
async function spriteWorld() {
  const world = await syntheticWorld();
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-spec-values-")));
  gitTarget(dir);
  const init = await cli([
    ...["init", "--directory", dir, "--world", "Synthetic Grove"],
    ...["--profile-preset", "sprite-32", "--style-preset", "flat-cartoon-kids", "--json"],
  ]);
  assert.equal(init.code, 0, init.stderr);
  const files = doc(init)["files"] as Array<{ path: string; role: string }>;
  const written = files.find((f) => f.role === "profile")?.path as string;
  world.profile = JSON.parse(await readFile(written, "utf8")) as TargetProfile;
  gitTarget(world.targetDir);
  approveProfile(world.profile, { targetDir: world.targetDir });
  return world;
}

test("a still spec without animationFamily is refused by stage and stage --dry-run before any paid call", async () => {
  const world = await spriteWorld();
  assert.match(world.profile.layout.media, /\{\{spec\.animationFamily\}\}/);
  const { script, calls } = await recordingScript(world.dir);
  for (const extra of [["--dry-run"], []]) {
    const r = await stage(world, stillSpec, script, extra);
    assert.equal(r.code, 2, r.stderr);
    assert.equal(doc(r)["error"].code, "invalid_input");
    assert.match(doc(r)["error"].message, /layout\.media needs spec\.animationFamily/);
    assert.equal(existsSync(calls), false, "the provider was consulted");
    assert.equal(existsSync(world.runsDir), false, "a run was started");
  }
});

test("a spec with animationFamily passes stage and pick against the same profile", async () => {
  const world = await spriteWorld();
  const staged = await stage(world, shelterSpec);
  assert.equal(staged.code, 0, staged.stderr);
  const r = await pick(doc(staged)["runDir"] as string, world.targetDir);
  assert.equal(r.code, 0, r.stderr);
});

test("a pick of a run staged before the check, whose spec lacks a value the layout names, exits 2 invalid_input", async () => {
  const world = await spriteWorld();
  const staged = await stage(world, shelterSpec);
  assert.equal(staged.code, 0, staged.stderr);
  const runDir = doc(staged)["runDir"] as string;
  const path = join(runDir, "run.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  delete record.spec.animationFamily;
  await writeFile(path, JSON.stringify(record, null, 2));
  const r = await pick(runDir, world.targetDir);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(doc(r)["error"].code, "invalid_input");
  assert.match(doc(r)["error"].message, /layout\.media needs spec\.animationFamily/);
  assert.equal(existsSync(join(world.targetDir, "assets")), false);
});

test("checkSpecValues names the layout field or the manifest key path the spec does not set", () => {
  const spec = { ...shelterSpec } as Partial<AssetSpec>;
  delete spec.animationFamily;
  assert.throws(
    () => checkSpecValues(syntheticProfile(), spec as AssetSpec),
    /layout\.media needs spec\.animationFamily, which the spec does not set/,
  );
  const profile = syntheticProfile({
    layout: { media: "a/{{spec.assetId}}.{{output.extension}}", manifest: "a/m.json" },
  });
  assert.throws(
    () => checkSpecValues(profile, spec as AssetSpec),
    /manifest\.animationFamily needs spec\.animationFamily, which the spec does not set/,
  );
  checkSpecValues(profile, shelterSpec);
});

test("checkSpecValues passes a whole-string optional value and counts spec.fields as set", () => {
  const profile = syntheticProfile({
    layout: { media: "a/{{spec.assetId}}.{{output.extension}}", manifest: "a/m.json" },
    manifest: {
      note: "{{spec.fields.missing?}}",
      label: "{{spec.fields.accessibilityLabel}}",
      family: "{{spec.animationFamily}}",
    },
  });
  const spec = { ...shelterSpec, fields: { accessibilityLabel: "Fern sheltering" } };
  checkSpecValues(profile, spec);
  assert.throws(
    () => checkSpecValues(profile, { ...spec, fields: {} }),
    /manifest\.label needs spec\.fields\.accessibilityLabel/,
  );
  const fromFields = syntheticProfile({
    layout: { media: "a/{{spec.family}}.{{output.extension}}", manifest: "a/m.json" },
    manifest: {},
  });
  checkSpecValues(fromFields, { ...shelterSpec, fields: { family: "idle" } });
});
