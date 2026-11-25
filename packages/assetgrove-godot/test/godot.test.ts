/**
 * The Godot pack through core (issue #422): built as a pack outside this repository is built and
 * installed in a temporary project, `write-families` hands a contact sheet's strips off with the
 * `godot:sprite-frames` preset, and a headless Godot loads what was written. These tests need
 * Godot 4.7.2 on PATH (CI's setup-godot puts it there), and without it each test skips with the
 * reason.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { sampleProfile, tempProject } from "@clockgrove/assetgrove/testing";
import type { CliResult } from "@clockgrove/assetgrove/testing";
import { GODOT_ARGS, INPUT_PATH, RESULT_PATH, projectFiles } from "../src/scratch.ts";
import { findGodot } from "./helpers/godot.ts";
import { buildPack, packNodeModules } from "./helpers/pack.ts";
import { contactSheet } from "./helpers/sheet.ts";

const NAME = "@clockgrove/assetgrove-godot";
const { godot: GODOT, skip: SKIP } = findGodot();
const usable = GODOT !== undefined;

/** Texture import options a pixel-art game sets; `process/fix_alpha_border` is not Godot's default. */
const PIXEL_IMPORT = {
  "compress/mode": 0,
  "mipmaps/generate": false,
  "process/fix_alpha_border": false,
};
/** Asserts an `.import` carries every option of `PIXEL_IMPORT`, as Godot wrote it. */
function carriesOptions(file: string): void {
  assert.match(file, /^compress\/mode=0$/m);
  assert.match(file, /^mipmaps\/generate=false$/m);
  assert.match(file, /^process\/fix_alpha_border=false$/m);
}

const stage = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-godot-")));
const project = tempProject();
const approved: Array<Record<string, unknown>> = [];

function settings() {
  project.writeSettings({
    extensions: [NAME],
    extensionSettings: { [NAME]: { godot: GODOT } },
    commands: { approved },
  });
}

after(async () => {
  project.close();
  await rm(stage, { recursive: true, force: true });
});

/** Runs git in the project; a failure's error carries git's own message. */
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: project.dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const text = (path: string) => readFileSync(join(project.dir, path), "utf8");

/** Runs a core command; a tool run it needs approved is added to the settings, as a person would. */
async function approving(args: string[]): Promise<CliResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await project.cli(args);
    if (result.code !== 8) return result;
    const confirmation = (result.json?.["error"] as { confirmation?: { command?: object } }) ?? {};
    const command = confirmation.confirmation?.command as
      { hash: string; argv: string[] } | undefined;
    assert.ok(command, result.stdout + result.stderr);
    approved.push({ hash: command.hash, kind: "tool", argv: command.argv, note: "godot test" });
    settings();
  }
  throw new Error("the approval did not hold");
}

let imported = "";
const importFamilies = async (families: Array<{ name: string; frames: number[] }>) => {
  const grouping = JSON.parse(readFileSync(join(imported, "grouping.json"), "utf8")) as object;
  const path = join(stage, `grouping-${families.map((f) => f.name).join("-")}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      ...grouping,
      status: "confirmed",
      families: families.map((f) => ({ ...f, reason: "a test family" })),
    }),
  );
  return approving([
    ...["write-families", "--import", imported, "--target", project.dir],
    ...["--grouping", path, "--json"],
  ]);
};

before(async () => {
  if (!usable) return;
  const pack = buildPack(stage);
  const installed = project.install(pack, NAME);
  symlinkSync(packNodeModules, join(installed, "node_modules"), "junction");
  // The installed pack links to the pack's dependencies; Godot must not scan into them.
  writeFileSync(join(project.dir, "node_modules", ".gdignore"), "");
  settings();
  writeFileSync(
    join(project.dir, "project.godot"),
    'config_version=5\n\n[application]\n\nconfig/name="fixture"\n',
  );
  git("add", "project.godot");
  git("commit", "--quiet", "-m", "a godot project");
  const profile = sampleProfile({
    frames: { width: 32, height: 40, maxEdge: 256, durationMs: 100 },
    layout: {
      media: "assets/{{spec.assetId}}-{{spec.animationFamily}}.{{output.extension}}",
      manifest: "assets/manifests/{{spec.assetId}}-{{spec.animationFamily}}.json",
    },
    handoff: [
      { preset: "manifest" },
      {
        preset: "godot:sprite-frames",
        options: { resource: "characters/{assetId}.tres", import: PIXEL_IMPORT },
      },
    ],
  });
  writeFileSync(join(stage, "sheet.png"), contactSheet());
  writeFileSync(join(stage, "profile.json"), JSON.stringify(profile));
  const made = await project.cli([
    ...["import", "--sheet", join(stage, "sheet.png"), "--profile", join(stage, "profile.json")],
    ...["--asset", "fern", "--tool", "hand drawn", "--no-propose", "--digital-source-type"],
    ...["digitalCreation", "--imports", join(stage, "imports"), "--json"],
  ]);
  assert.equal(made.code, 0, made.stderr + made.stdout);
  imported = String(made.json?.["importDir"]);
});

const headerUid = (path: string) => /^\[gd_resource[^\]]*uid="([^"]+)"/.exec(text(path))?.[1];

/** Loads the SpriteFrames in a headless Godot and returns what it printed. */
function loaded(): string {
  const script = join(stage, "load.gd");
  writeFileSync(
    script,
    `extends SceneTree
func _init():
\tvar frames = load("res://characters/fern.tres") as SpriteFrames
\tfor name in frames.get_animation_names():
\t\tvar ok = true
\t\tfor i in frames.get_frame_count(name):
\t\t\tok = ok and frames.get_frame_texture(name, i) != null
\t\tprint("ANIM ", name, " ", frames.get_frame_count(name), " ", ok)
\tquit()
`,
  );
  const godot = (...args: string[]) =>
    spawnSync(GODOT!, ["--headless", "--path", project.dir, ...args], { encoding: "utf8" });
  const imports = godot("--import");
  assert.doesNotMatch(imports.stdout + imports.stderr, /ERROR/);
  const run = godot("--script", script);
  const out = run.stdout + run.stderr;
  assert.doesNotMatch(out, /ERROR/);
  return out;
}
const animations = (out: string) =>
  [...out.matchAll(/^ANIM (\S+) (\d+) (true|false)$/gm)]
    .map((m) => `${m[1]}:${m[2]}:${m[3]}`)
    .sort();

let firstUid: string | undefined;
let idleImport = "";
let walkImport = "";

test("a strip handed off writes the SpriteFrames and each strip's .import, and Godot loads it", async (t) => {
  if (!usable) return t.skip(SKIP!);
  const done = await importFamilies([
    { name: "idle", frames: [1, 2, 3, 4] },
    { name: "walk", frames: [5, 6, 7] },
  ]);
  assert.equal(done.code, 0, done.stderr + done.stdout);
  const tres = text("characters/fern.tres");
  idleImport = text("assets/fern-idle.png.import");
  walkImport = text("assets/fern-walk.png.import");
  for (const [family, file] of [
    ["idle", idleImport],
    ["walk", walkImport],
  ] as const) {
    const uid = /^uid="(uid:\/\/[^"]+)"/m.exec(file)?.[1];
    assert.ok(uid, `${family}.import has a UID`);
    carriesOptions(file);
    assert.match(
      tres,
      new RegExp(
        `\\[ext_resource [^\\]]*uid="${uid}"[^\\]]*path="res://assets/fern-${family}\\.png"|path="res://assets/fern-${family}\\.png"[^\\]]*uid="${uid}"`,
      ),
    );
  }
  firstUid = headerUid("characters/fern.tres");
  assert.ok(firstUid);
  assert.deepEqual(animations(loaded()), ["idle:4:true", "walk:3:true"]);
});

test("a later family keeps the earlier ones in one SpriteFrames", async (t) => {
  if (!usable) return t.skip(SKIP!);
  // The developer changed an option of the idle strip's .import: the profile's `import` would
  // set it back, so an unchanged file shows the options never reach an existing .import.
  const edited = idleImport.replace(
    /^process\/fix_alpha_border=false$/m,
    "process/fix_alpha_border=true",
  );
  assert.notEqual(edited, idleImport);
  writeFileSync(join(project.dir, "assets/fern-idle.png.import"), edited);
  git("add", "assets/fern-idle.png.import");
  git("commit", "--quiet", "-m", "the developer's own idle import option");
  idleImport = edited;
  const done = await importFamilies([{ name: "attack", frames: [6, 7, 8] }]);
  assert.equal(done.code, 0, done.stderr + done.stdout);
  assert.deepEqual(animations(loaded()), ["attack:3:true", "idle:4:true", "walk:3:true"]);
  // The new strip's .import gets the options too.
  carriesOptions(text("assets/fern-attack.png.import"));
});

test("a replaced resource keeps its UID and an existing .import is never touched", async (t) => {
  if (!usable) return t.skip(SKIP!);
  assert.equal(headerUid("characters/fern.tres"), firstUid);
  assert.equal(text("assets/fern-idle.png.import"), idleImport);
  assert.equal(text("assets/fern-walk.png.import"), walkImport);
});

/** The `godot:sprite-frames` entry of each family a write-families run handed off. */
const spriteFramesEntries = (done: CliResult) =>
  (
    done.json?.["families"] as Array<{
      result: { handoff: Array<{ preset: string; warnings?: string[] }> };
    }>
  ).map((f) => f.result.handoff.find((h) => h.preset === "godot:sprite-frames"));

test("a pixel-art profile's strip warns when the project's default texture filter is not Nearest, and never edits project.godot", async (t) => {
  if (!usable) return t.skip(SKIP!);
  // The import's profile becomes pixel art: crisp edges with a palette colour rule.
  const recordPath = join(imported, "import.json");
  const record = readFileSync(recordPath, "utf8");
  const parsed = JSON.parse(record) as { profile: { style?: Record<string, unknown> } };
  parsed.profile.style = {
    ...parsed.profile.style,
    edges: "crisp",
    color: { rule: "palette", palette: ["#6b4a2b", "#4d8a3c"] },
  };
  const godotFile = join(project.dir, "project.godot");
  const linear = readFileSync(godotFile);
  try {
    writeFileSync(recordPath, JSON.stringify(parsed));
    // The fixture project leaves the filter at Godot's default, Linear.
    const warned = await importFamilies([{ name: "jump", frames: [2, 3] }]);
    assert.equal(warned.code, 0, warned.stderr + warned.stdout);
    const [entry] = spriteFramesEntries(warned);
    assert.equal(entry?.warnings?.length, 1, JSON.stringify(entry));
    assert.match(
      entry!.warnings![0]!,
      /rendering\/textures\/canvas_textures\/default_texture_filter/,
    );
    assert.match(entry!.warnings![0]!, /Linear \(1\)/);
    assert.match(entry!.warnings![0]!, /Nearest \(0\)/);
    assert.deepEqual(readFileSync(godotFile), linear);

    const nearest = `${linear.toString()}\n[rendering]\n\ntextures/canvas_textures/default_texture_filter=0\n`;
    writeFileSync(godotFile, nearest);
    git("commit", "--quiet", "-am", "nearest filtering");
    const quiet = await importFamilies([{ name: "jump", frames: [3, 4] }]);
    assert.equal(quiet.code, 0, quiet.stderr + quiet.stdout);
    assert.equal(spriteFramesEntries(quiet)[0]?.warnings, undefined);
    assert.equal(text("project.godot"), nearest);
  } finally {
    writeFileSync(recordPath, record);
    writeFileSync(godotFile, linear);
    // Only after the Nearest commit is there a change to commit back; a failure before it must
    // fail the test with its own error, not with git's "nothing to commit".
    if (git("status", "--porcelain", "--", "project.godot") !== "")
      git("commit", "--quiet", "-am", "linear filtering again");
  }
});

test("an earlier strip Godot cannot decode fails the hand-off with exit 6 and leaves the resource as it was", async (t) => {
  if (!usable) return t.skip(SKIP!);
  const before = text("characters/fern.tres");
  const path = join(project.dir, "assets", "fern-idle.png");
  const strip = readFileSync(path);
  writeFileSync(path, "these bytes are not an image");
  try {
    const failed = await importFamilies([{ name: "attack", frames: [6, 7, 8] }]);
    assert.equal(failed.code, 6, failed.stderr + failed.stdout);
    assert.equal((failed.json?.["error"] as { code?: string }).code, "handoff_check_failed");
    assert.equal(text("characters/fern.tres"), before);
  } finally {
    writeFileSync(path, strip);
  }
});

test("the build script fails on a Godot that is not the release the input names", (t) => {
  if (!usable) return t.skip(SKIP!);
  const scratch = join(stage, "other-release");
  const files = {
    ...projectFiles(),
    [INPUT_PATH]: JSON.stringify({
      godot: "4.6.0-stable",
      resource: "res://empty.tres",
      frameWidth: 32,
      frameHeight: 40,
      animations: [],
    }),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(scratch, path)), { recursive: true });
    writeFileSync(join(scratch, path), content);
  }
  const run = spawnSync(GODOT!, GODOT_ARGS, { cwd: scratch, encoding: "utf8" });
  const result = JSON.parse(readFileSync(join(scratch, RESULT_PATH), "utf8")) as {
    ok: boolean;
    errors: string[];
  };
  assert.equal(result.ok, false);
  assert.match(
    result.errors.join("\n"),
    /this is Godot 4\.7\.2-stable, not the pinned 4\.6\.0-stable/,
  );
  assert.match(run.stdout + run.stderr, /ERROR: assetgrove-godot: this is Godot/);
});
