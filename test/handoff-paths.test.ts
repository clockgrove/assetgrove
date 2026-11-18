import "./fixtures/env.ts";
import { approve, approveProfile, settingsPath, stateDir } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { failureOutcome } from "../src/commands/result.ts";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { DIGITAL_SOURCE_TYPES } from "../src/metadata.ts";
import { checkLayout, checkWrites } from "../src/paths.ts";
import { defaultRoutes } from "../src/routes.ts";
import { importSheet, writeFamilies } from "../src/sheet/import.ts";
import type { Grouping } from "../src/sheet/types.ts";
import type { TargetProfile } from "../src/types.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import { shelterSpec, syntheticProfile, syntheticWorld } from "./fixtures/synthetic.ts";
import type { World } from "./fixtures/synthetic.ts";
import { gitTarget } from "./fixtures/git.ts";

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
  return (await readdir(dir, { recursive: true }))
    .map((entry) => entry.toString().replaceAll("\\", "/"))
    .filter((entry) => entry !== ".git" && !entry.startsWith(".git/"));
}

/** Writes the world's inputs and stages one candidate through the CLI. */
async function stage(world: World, spec = shelterSpec): Promise<Result> {
  const specPath = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(specPath, JSON.stringify(spec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  return cli([
    "stage",
    ...["--spec", specPath, "--bible", bible, "--profile", profile],
    ...["--runs", world.runsDir, "--candidates", "1"],
    ...["--provider-script", passingScript, "--json"],
  ]);
}

/** A world whose profile `change` edits (its validator approved), with one candidate staged. */
async function stagedWorld(change: (profile: TargetProfile) => void = () => {}) {
  const world = await syntheticWorld();
  gitTarget(world.targetDir);
  change(world.profile);
  approveProfile(world.profile, { targetDir: world.targetDir });
  const staged = await stage(world);
  assert.equal(staged.code, 0, staged.stderr);
  return { world, runDir: doc(staged)["runDir"] as string };
}

function pick(runDir: string, targetDir: string): Promise<Result> {
  return cli(["pick", "--run", runDir, "--candidate", "c1", "--target", targetDir, "--json"]);
}

/** A directory link that needs no privilege on Windows (a junction) and is a symlink elsewhere. */
function linkDir(target: string, path: string): Promise<void> {
  return symlink(target, path, "junction");
}

test("a pick through a link in the target to another directory exits 2 with nothing written there", async () => {
  const { world, runDir } = await stagedWorld();
  const outside = join(world.dir, "outside");
  await mkdir(outside);
  await linkDir(outside, join(world.targetDir, "assets"));
  const r = await pick(runDir, world.targetDir);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(doc(r)["error"].code, "invalid_input");
  assert.match(doc(r)["error"].message, /leaves the target directory/);
  assert.deepEqual(await tree(outside), []);
});

test("a pick through a link in the target to the settings directory leaves the settings as they were", async () => {
  const configDir = dirname(settingsPath);
  const { world, runDir } = await stagedWorld((profile) => {
    profile.layout = { ...profile.layout, manifest: "docs/settings.json" };
  });
  const before = await readFile(settingsPath, "utf8");
  await linkDir(configDir, join(world.targetDir, "docs"));
  const r = await pick(runDir, world.targetDir);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(doc(r)["error"].code, "invalid_input");
  assert.equal(await readFile(settingsPath, "utf8"), before);
  assert.equal(existsSync(join(world.targetDir, "assets")), false);
});

test("a pick whose target is, holds or lies in the settings or state directory exits 2 with nothing written", async () => {
  const configDir = dirname(settingsPath);
  const { world, runDir } = await stagedWorld();
  for (const target of [configDir, stateDir, dirname(configDir), join(configDir, "approvals")]) {
    await mkdir(target, { recursive: true });
    const r = await pick(runDir, target);
    assert.equal(r.code, 2, `${target}: ${r.stderr}`);
    assert.equal(doc(r)["error"].code, "invalid_input");
    assert.match(doc(r)["error"].message, /settings or state directory/);
    assert.equal(existsSync(join(target, "assets")), false);
  }
  assert.equal(existsSync(join(world.targetDir, "assets")), false);
});

/** Sets the layout of the profile a staged run carries into its pick. */
async function relayout(runDir: string, layout: Partial<TargetProfile["layout"]>): Promise<void> {
  const path = join(runDir, "run.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  record.profile.layout = { ...record.profile.layout, ...layout };
  await writeFile(path, JSON.stringify(record, null, 2));
}

test("a hand-off never writes over the file the approved validator runs, nor into .git", async () => {
  const check = "process.exit(0);\n";
  const { world, runDir } = await stagedWorld((profile) => {
    profile.validator = { command: [process.execPath, "check.mjs", "{{manifest}}"] };
  });
  await writeFile(join(world.targetDir, "check.mjs"), check);
  approveProfile(world.profile, { targetDir: world.targetDir });
  for (const manifest of ["check.mjs", "./check.mjs", ".git/hooks/post-checkout", ".GIT/config"]) {
    await relayout(runDir, { manifest });
    const r = await pick(runDir, world.targetDir);
    assert.equal(r.code, 2, `${manifest}: ${r.stderr}`);
    assert.equal(doc(r)["error"].code, "invalid_input");
    assert.deepEqual(await tree(world.targetDir), [".gitattributes", "check.mjs"]);
    assert.equal(await readFile(join(world.targetDir, "check.mjs"), "utf8"), check);
  }
  // stage refuses a .git layout before it spends.
  world.profile.layout = { ...world.profile.layout, manifest: ".git/hooks/post-checkout" };
  const staged = await stage(world);
  assert.equal(staged.code, 2, staged.stderr);
  assert.match(doc(staged)["error"].message, /\.git/);
});

test("pick's JSON result carries no bible text outside sharedText", async () => {
  const { world, runDir } = await stagedWorld();
  const r = await pick(runDir, world.targetDir);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /dark mask/);
  assert.equal(doc(r)["candidate"].id, "c1");
  // The written manifest still records the prompt.
  assert.match(await readFile(doc(r)["manifestPath"], "utf8"), /dark mask/);
});

test("checkWrites refuses one path written twice and names Windows cannot hold", () => {
  assert.throws(() => checkWrites(["a/fern.png", "a/fern.png"]), /same path/);
  assert.throws(() => checkWrites(["a/fern.png", "a/./fern.png"]), /same path/);
  for (const bad of [
    "assets/con/shelter.png",
    "assets/NUL.txt",
    "assets/lpt1.json",
    "assets/com9",
    "assets/hero./shelter.png",
    "assets/hero /shelter.png",
    "assets/a?b/shelter.png",
    "assets/x\\y/shelter.png",
    "assets/a*b.png",
    'assets/a"b.png',
    "assets/a<b.png",
    "assets/a|b.png",
    "assets/a\u0001b.png",
  ]) {
    assert.throws(() => checkWrites([bad]), /written path/, bad);
  }
  checkWrites(["assets/console/shelter.png", "assets/a.b/c.png", "assets/conx.png", "../a.png"]);
});

test("a layout that sends the provenance onto the media exits 2 with nothing written", async () => {
  const { world, runDir } = await stagedWorld();
  await relayout(runDir, { provenance: world.profile.layout.media });
  const r = await pick(runDir, world.targetDir);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(doc(r)["error"].code, "invalid_input");
  assert.match(doc(r)["error"].message, /same path/);
  assert.deepEqual(await tree(world.targetDir), [".gitattributes"]);

  // Two layout paths that reach one file through a link are refused the same way.
  await mkdir(join(world.targetDir, "assets"));
  await linkDir(join(world.targetDir, "assets"), join(world.targetDir, "alias"));
  await relayout(runDir, {
    media: "assets/{{spec.assetId}}.{{output.extension}}",
    provenance: "alias/{{spec.assetId}}.{{output.extension}}",
  });
  const linked = await pick(runDir, world.targetDir);
  assert.equal(linked.code, 2, linked.stderr);
  assert.match(doc(linked)["error"].message, /reach one file/);
  assert.deepEqual(await readdir(join(world.targetDir, "assets")), []);

  // stage refuses the same layout before it spends.
  world.profile.layout = { ...world.profile.layout, provenance: world.profile.layout.media };
  const staged = await stage(world);
  assert.equal(staged.code, 2, staged.stderr);
  assert.match(doc(staged)["error"].message, /same path/);
});

test("stage refuses a layout path it could never write before any paid call", async () => {
  for (const assetId of ["fern:x", "con", "hero.", "a?b"]) {
    const world = await syntheticWorld();
    gitTarget(world.targetDir);
    approveProfile(world.profile, { targetDir: world.targetDir });
    const r = await stage(world, { ...shelterSpec, assetId });
    assert.equal(r.code, 2, `${assetId}: ${r.stderr}`);
    assert.equal(doc(r)["error"].code, "invalid_input");
    assert.match(doc(r)["error"].message, /written path/);
    assert.equal(existsSync(world.runsDir), false);
  }
  // Values only known at hand-off are not judged before it.
  checkLayout(
    syntheticProfile({
      layout: { media: "a/{{run.pickedAt}}.{{output.extension}}", manifest: "a/m.json" },
    }),
    shelterSpec,
  );
  assert.throws(
    () => checkLayout(syntheticProfile(), { ...shelterSpec, assetId: ".git" }),
    /\.git/,
  );
});

test("write-families refuses a layout that maps two families to one path, before writing any", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-paths-"));
  const targetDir = join(dir, "target");
  gitTarget(targetDir);
  const profile = syntheticProfile({
    layout: { media: "assets/{{spec.assetId}}.png", manifest: "assets/{{spec.assetId}}.json" },
  });
  delete profile.validator;
  const call = new Caller({
    provider: new ScriptedProvider({
      image: () => ({ images: [], costUsd: 0 }),
      vision: () => ({
        text: JSON.stringify({
          families: [
            { name: "idle", frames: [1, 2, 3, 4], reason: "standing still" },
            { name: "idle-left", mirrorOf: "idle", reason: "mirrored" },
          ],
          unassigned: [],
        }),
        costUsd: 0,
      }),
    }),
    providerName: "scripted",
    budget: new Budget(5),
    routes: defaultRoutes,
  });
  const { importDir, grouping } = await importSheet({
    digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
    sheet: syntheticSheet().png,
    sheetPath: "sheets/synthetic.png",
    tool: "synthetic",
    assetId: "fern",
    profile,
    importsDir: join(dir, "imports"),
    importId: "imp1",
    propose: { call },
  });
  assert.equal(grouping.families.length, 2);
  const confirmed: Grouping = { ...grouping, status: "confirmed" };
  const outcome = failureOutcome(
    await writeFamilies({ importDir, grouping: confirmed, targetDir }).then(
      () => undefined,
      (e: unknown) => e,
    ),
  );
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.error?.code, "invalid_input");
  assert.match(outcome.error?.message ?? "", /same path/);
  assert.deepEqual(await tree(targetDir), [".gitattributes"]);
});

test("plan refuses a layout path it could never write before any paid call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-paths-plan-"));
  gitTarget(dir);
  const init = await cli([
    ...["init", "--directory", dir, "--world", "Synthetic Grove"],
    ...["--profile-preset", "sprite-32", "--style-preset", "flat-cartoon-kids", "--json"],
  ]);
  assert.equal(init.code, 0, init.stderr);
  const files = doc(init)["files"] as Array<{ path: string; role: string }>;
  const bible = files.find((f) => f.role === "bible")?.path as string;
  const spec = join(dir, "spec.json");
  await writeFile(
    spec,
    JSON.stringify({ kind: "still", assetId: "con", animationFamily: "idle", subject: "icon" }),
  );
  const profile = join(dir, "profile.json");
  await writeFile(profile, JSON.stringify(syntheticProfile()));
  const plan = join(dir, "plan.json");
  const r = await cli([
    ...["plan", "--spec", spec, "--bible", bible, "--profile", profile],
    ...["--out", plan, "--json"],
  ]);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(doc(r)["error"].code, "invalid_input");
  assert.match(doc(r)["error"].message, /reserved device/);
  assert.equal(existsSync(plan), false);
});
