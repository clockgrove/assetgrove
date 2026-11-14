import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { initBible, loadBible } from "../src/bible.ts";
import { encodePng } from "../src/image/raster.ts";
import { loadProfile, loadStyleBible } from "../src/inputs.ts";
import { parseGait, parseTemplate } from "../src/model3d/rig/template.ts";
import {
  FormatError,
  formatLine,
  readFormat,
  registerMigration,
  unregisterMigration,
} from "../src/formats.ts";
import { buildBirdCastSet } from "./fixtures/identity-set/birds.ts";
import {
  drawSubject,
  shelterSpec,
  syntheticProfile,
  syntheticWorld,
} from "./fixtures/synthetic.ts";

function refusal(reason: string) {
  return (error: unknown) => {
    assert.ok(error instanceof FormatError, String(error));
    assert.equal(error.code, "format_unsupported");
    assert.equal(error.reason, reason);
    return true;
  };
}

test("a current format reads as is", () => {
  const result = readFormat("recipe", { format: "assetgrove-recipe/1", name: "x" }, "r.json");
  assert.equal(result.version, 1);
  assert.equal(result.migratedFrom, undefined);
  assert.equal(result.value["name"], "x");
  assert.equal(formatLine("recipe"), "assetgrove-recipe/1");
});

test("a missing format is refused with reason missing, naming the line to add", () => {
  assert.throws(() => readFormat("recipe", { name: "x" }, "r.json"), refusal("missing"));
  assert.throws(
    () => readFormat("recipe", { name: "x" }, "r.json"),
    /"format": "assetgrove-recipe\/1"/,
  );
  assert.throws(() => readFormat("recipe", "not an object", "r.json"), refusal("missing"));
});

test("a newer format is refused with reason too_new", () => {
  assert.throws(
    () => readFormat("target-profile", { format: "assetgrove-target-profile/2" }, "p.json"),
    refusal("too_new"),
  );
});

test("an unknown kind or a mismatched format is refused with reason unknown", () => {
  assert.throws(
    () => readFormat("nonsense", { format: "assetgrove-nonsense/1" }, "x"),
    refusal("unknown"),
  );
  assert.throws(
    () => readFormat("recipe", { format: "assetgrove-style-preset/1" }, "x"),
    refusal("unknown"),
  );
  assert.throws(() => readFormat("recipe", { format: "recipe v1" }, "x"), refusal("unknown"));
});

test("a registered 1-to-2 migration moves an older file forward and reports migratedFrom", (t) => {
  registerMigration("test-kind", 1, (value) => {
    const { oldName, ...rest } = value;
    return { ...rest, newName: oldName };
  });
  t.after(() => unregisterMigration("test-kind", 1));
  const result = readFormat(
    "test-kind",
    { format: "assetgrove-test-kind/1", oldName: "a" },
    "t",
    2,
  );
  assert.equal(result.migratedFrom, 1);
  assert.equal(result.version, 2);
  assert.deepEqual(result.value, { format: "assetgrove-test-kind/2", newName: "a" });
  // Without the step, the older version cannot be read.
  unregisterMigration("test-kind", 1);
  assert.throws(
    () => readFormat("test-kind", { format: "assetgrove-test-kind/1" }, "t", 2),
    refusal("unknown"),
  );
});

// --- Shared files through the CLI and the loaders (issue #167) ---

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const exec = promisify(execFile);

async function cli(...args: string[]): Promise<{ code: number; doc: Record<string, unknown> }> {
  try {
    const { stdout } = await exec(process.execPath, [CLI, ...args, "--json"]);
    return { code: 0, doc: JSON.parse(stdout) };
  } catch (error) {
    const e = error as { code: number; stdout: string };
    return { code: e.code, doc: JSON.parse(e.stdout) };
  }
}

const withoutFormat = <T extends { format?: string }>(value: T): Omit<T, "format"> => {
  const { format: _dropped, ...rest } = value;
  void _dropped;
  return rest;
};
const unversionedMarkdown = (source: string) => source.replace(/^format: .*\n/m, "");
const PROSE = "# Synthetic\n\n## Do's and Don'ts\n\nDo follow the anchors.\n";

function assertMissing(run: { code: number; doc: Record<string, unknown> }, line: string) {
  assert.equal(run.code, 2, JSON.stringify(run.doc));
  const error = run.doc["error"] as { code: string; reason: string; message: string };
  assert.equal(error.code, "format_unsupported");
  assert.equal(error.reason, "missing");
  assert.ok(error.message.includes(`"format": "${line}"`), error.message);
}

test("each shared kind without a format line exits 2 format_unsupported, reason missing, through the CLI", async (t) => {
  const world = await syntheticWorld();
  t.after(() => rm(world.dir, { recursive: true, force: true }));
  const dir = world.dir;
  const png = join(dir, "hero.png");
  await writeFile(png, encodePng(drawSubject(24)));
  const recipe = { format: "assetgrove-recipe/1", steps: [{ op: "trim" }] };
  await writeFile(join(dir, "recipe.json"), JSON.stringify(recipe));
  await writeFile(join(dir, "recipe-old.json"), JSON.stringify(withoutFormat(recipe)));
  await writeFile(join(dir, "profile.json"), JSON.stringify(world.profile));
  await writeFile(join(dir, "profile-old.json"), JSON.stringify(withoutFormat(world.profile)));
  await writeFile(join(dir, "spec.json"), JSON.stringify(shelterSpec));
  await writeFile(join(world.bibleDir, "bible.json"), JSON.stringify(world.bible));
  await writeFile(
    join(world.bibleDir, "bible-old.json"),
    JSON.stringify(withoutFormat(world.bible)),
  );

  // target-profile
  assertMissing(
    await cli(
      "recipe",
      join(dir, "recipe.json"),
      png,
      "--profile",
      join(dir, "profile-old.json"),
      "--out",
      join(dir, "out"),
    ),
    formatLine("target-profile"),
  );
  // recipe
  assertMissing(
    await cli("recipe", join(dir, "recipe-old.json"), png, "--out", join(dir, "out")),
    formatLine("recipe"),
  );
  // style-bible, the JSON bible
  assertMissing(
    await cli(
      "stage",
      ...["--spec", join(dir, "spec.json"), "--bible", join(world.bibleDir, "bible-old.json")],
      ...["--profile", join(dir, "profile.json"), "--runs", join(dir, "runs"), "--dry-run"],
    ),
    formatLine("style-bible"),
  );
  // style-bible, BIBLE.md front matter
  const init = join(dir, "init");
  const { biblePath } = await initBible({
    directory: init,
    world: "Synthetic",
    preset: "cozy-storybook",
  });
  assert.equal((await cli("bible", "describe", "--bible", biblePath)).code, 0);
  const versioned = await readFile(biblePath, "utf8");
  await writeFile(biblePath, unversionedMarkdown(versioned));
  assertMissing(await cli("bible", "describe", "--bible", biblePath), formatLine("style-bible"));
  await writeFile(biblePath, versioned);
  // style-preset
  const preset = join(dirname(biblePath), "presets", "flat-cartoon-kids.md");
  assert.match(await readFile(preset, "utf8"), /^---\nformat: assetgrove-style-preset\/1\n/);
  await writeFile(preset, unversionedMarkdown(await readFile(preset, "utf8")));
  assertMissing(
    await cli("bible", "preset", "--bible", biblePath, "--preset", "flat-cartoon-kids"),
    formatLine("style-preset"),
  );
});

test("every fixture under test/fixtures, every preset and every file in docs/examples loads", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-formats-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // test/fixtures: the synthetic profile and JSON bible, and the bird cast's BIBLE.md files.
  const world = await syntheticWorld();
  t.after(() => rm(world.dir, { recursive: true, force: true }));
  await writeFile(join(dir, "profile.json"), JSON.stringify(syntheticProfile()));
  assert.equal((await loadProfile(join(dir, "profile.json"))).value.name, "synthetic-grove");
  await writeFile(join(world.bibleDir, "bible.json"), JSON.stringify(world.bible));
  assert.equal(
    (await loadStyleBible(join(world.bibleDir, "bible.json"))).value.version,
    "synthetic-1",
  );
  const birds = await buildBirdCastSet(join(dir, "birds"));
  for (const path of [birds.biblePath, birds.conflictBiblePath]) await loadBible(path);
  // skills/art-direction/presets: each is a style preset.
  const presets = join(ROOT, "skills/art-direction/presets");
  const presetFiles = (await readdir(presets)).filter((name) => name.endsWith(".md"));
  assert.ok(presetFiles.length >= 3);
  for (const name of presetFiles) {
    const preset = await loadBible(join(presets, name), "style-preset");
    assert.equal(preset.data.format, formatLine("style-preset"));
  }
  // docs/examples: the profile fragment is a target profile; the rig template and gait are not
  // shared kinds and load through their own validators.
  const examples = join(ROOT, "docs/examples/rig");
  const files = (await readdir(examples)).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(files, ["profile-fragment.json", "quadruped-template.json", "walk.json"]);
  await loadProfile(join(examples, "profile-fragment.json"));
  const template = parseTemplate(
    JSON.parse(await readFile(join(examples, "quadruped-template.json"), "utf8")),
  );
  parseGait(JSON.parse(await readFile(join(examples, "walk.json"), "utf8")), template, "walk.json");
});

test("a profile with an unknown top-level field exits 2 invalid_input", async (t) => {
  const world = await syntheticWorld();
  t.after(() => rm(world.dir, { recursive: true, force: true }));
  const png = join(world.dir, "hero.png");
  await writeFile(png, encodePng(drawSubject(24)));
  await writeFile(
    join(world.dir, "recipe.json"),
    JSON.stringify({ format: "assetgrove-recipe/1", steps: [{ op: "trim" }] }),
  );
  const profile = join(world.dir, "profile.json");
  await writeFile(profile, JSON.stringify({ ...world.profile, palettte: ["#000000"] }));
  const run = await cli(
    "recipe",
    join(world.dir, "recipe.json"),
    png,
    "--profile",
    profile,
    "--out",
    join(world.dir, "out"),
  );
  assert.equal(run.code, 2);
  const error = run.doc["error"] as { code: string; message: string };
  assert.equal(error.code, "invalid_input");
  assert.match(error.message, /unknown top-level field "palettte"/);
  // A known field of the wrong type is refused too.
  await writeFile(profile, JSON.stringify({ ...world.profile, name: 7 }));
  await assert.rejects(loadProfile(profile), /name/);
});
