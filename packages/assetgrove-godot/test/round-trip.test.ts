/**
 * A hand-off over a developer's work in a pinned Godot project (issue #470): `godot:sprite-frames`
 * is run again after the developer, in Godot itself, added an animation to the SpriteFrames, built
 * a scene on it and changed an import option. Their animation, scene, stable UIDs and import
 * settings must survive, and an overwrite of what they changed is reported before anything is
 * written. These tests need Godot 4.7.2 on PATH (CI's setup-godot puts it there), and without it
 * each test skips with the reason.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { sampleProfile, tempProject } from "@clockgrove/assetgrove/testing";
import type { CliResult } from "@clockgrove/assetgrove/testing";
import { findGodot } from "./helpers/godot.ts";
import { buildPack, packNodeModules } from "./helpers/pack.ts";
import { contactSheet } from "./helpers/sheet.ts";

const NAME = "@clockgrove/assetgrove-godot";
const { godot: GODOT, skip: SKIP } = findGodot();
const usable = GODOT !== undefined;
const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/round-trip/${name}`, import.meta.url));

const PIXEL_IMPORT = {
  "compress/mode": 0,
  "mipmaps/generate": false,
  "process/fix_alpha_border": false,
};

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

const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: project.dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const bytes = (path: string) => readFileSync(join(project.dir, path));
const text = (path: string) => readFileSync(join(project.dir, path), "utf8");
const headerUid = (path: string) => /^\[gd_resource[^\]]*uid="([^"]+)"/.exec(text(path))?.[1];

/** Every file under the folders, by path, with its bytes. */
function snapshot(...folders: string[]): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const folder of folders)
    for (const name of readdirSync(join(project.dir, folder), { recursive: true })) {
      const path = join(folder, String(name));
      if (statSync(join(project.dir, path)).isFile()) files.set(path, bytes(path));
    }
  return files;
}

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

const godot = (...args: string[]) =>
  spawnSync(GODOT!, ["--headless", "--path", project.dir, ...args], { encoding: "utf8" });

/** Runs a script in the project with Godot and returns what it printed, failing on an ERROR. */
function run(script: string): string {
  const result = godot("--script", script);
  const out = result.stdout + result.stderr;
  assert.equal(result.status, 0, out);
  assert.doesNotMatch(out, /ERROR/);
  return out;
}

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

const IMPORTS = [
  "assets/fern-idle.png.import",
  "assets/fern-walk.png.import",
  "art/hurt.png.import",
];
let firstUid: string | undefined;
let imports = new Map<string, Buffer>();
let scene = Buffer.alloc(0);
let idleStrip = Buffer.alloc(0);

test("a first hand-off writes idle and walk", async (t) => {
  if (!usable) return t.skip(SKIP!);
  const done = await importFamilies([
    { name: "idle", frames: [1, 2, 3, 4] },
    { name: "walk", frames: [5, 6, 7] },
  ]);
  assert.equal(done.code, 0, done.stderr + done.stdout);
  firstUid = headerUid("characters/fern.tres");
  assert.ok(firstUid);
});

test("the developer adds an animation, a scene and an import option in Godot", (t) => {
  if (!usable) return t.skip(SKIP!);
  mkdirSync(join(project.dir, "art"), { recursive: true });
  writeFileSync(join(project.dir, "art/hurt.png"), contactSheet());
  const imported = godot("--import");
  assert.doesNotMatch(imported.stdout + imported.stderr, /ERROR/);
  assert.match(run(fixture("author.gd")), /^AUTHORED$/m);

  const idle = "assets/fern-idle.png.import";
  const edited = text(idle).replace(
    /^process\/fix_alpha_border=false$/m,
    "process/fix_alpha_border=true",
  );
  assert.notEqual(edited, text(idle));
  writeFileSync(join(project.dir, idle), edited);
  git("add", "art", "assets", "characters", "scenes");
  git("commit", "--quiet", "-m", "the developer's hurt animation, player scene and import option");

  imports = new Map(IMPORTS.map((path) => [path, bytes(path)]));
  scene = bytes("scenes/player.tscn");
  idleStrip = bytes("assets/fern-idle.png");
  assert.equal(headerUid("characters/fern.tres"), firstUid);
});

test("a re-export keeps the developer's animation, scene, UIDs and import settings", async (t) => {
  if (!usable) return t.skip(SKIP!);
  const done = await importFamilies([{ name: "idle", frames: [2, 3, 4, 5, 6] }]);
  assert.equal(done.code, 0, done.stderr + done.stdout);

  assert.equal(headerUid("characters/fern.tres"), firstUid);
  for (const [path, before] of imports) assert.deepEqual(bytes(path), before, path);
  assert.deepEqual(bytes("scenes/player.tscn"), scene);
  assert.notDeepEqual(bytes("assets/fern-idle.png"), idleStrip);

  const script = join(stage, "load-scene.gd");
  writeFileSync(
    script,
    `extends SceneTree
func _init():
\tvar root = (load("res://scenes/player.tscn") as PackedScene).instantiate()
\tvar sprite = root.get_node("Sprite") as AnimatedSprite2D
\tvar frames = sprite.sprite_frames
\tfor name in frames.get_animation_names():
\t\tprint("ANIM ", name, " ", frames.get_frame_count(name))
\tprint("SPEED hurt ", int(frames.get_animation_speed(&"hurt")))
\tprint("LOOP hurt ", frames.get_animation_loop(&"hurt"))
\tprint("PLAYER ", " ".join((root.get_node("Animator") as AnimationPlayer).get_animation_list()))
\tprint("CURRENT ", sprite.animation)
\troot.free()
\tquit()
`,
  );
  const reimported = godot("--import");
  assert.doesNotMatch(reimported.stdout + reimported.stderr, /ERROR/);
  const out = run(script);
  const anims = [...out.matchAll(/^ANIM (\S+) (\d+)$/gm)].map((m) => `${m[1]} ${m[2]}`).sort();
  assert.deepEqual(anims, ["hurt 2", "idle 5", "walk 3"]);
  assert.match(out, /^SPEED hurt 6$/m);
  assert.match(out, /^LOOP hurt false$/m);
  assert.match(out, /^PLAYER blink$/m);
  assert.match(out, /^CURRENT idle$/m);
});

test("a hand-off that would overwrite the developer's retimed idle reports the conflict and writes nothing", async (t) => {
  if (!usable) return t.skip(SKIP!);
  assert.match(run(fixture("edit-idle.gd")), /^EDITED$/m);
  git("add", "characters");
  git("commit", "--quiet", "-m", "the developer's own idle speed");
  const before = snapshot("assets", "characters", "scenes");

  const failed = await importFamilies([{ name: "idle", frames: [1, 2, 3] }]);
  assert.equal(failed.code, 6, failed.stderr + failed.stdout);
  const error = failed.json?.["error"] as { code?: string; problems?: Array<{ problem: string }> };
  assert.equal(error.code, "handoff_check_failed");
  const problems = (error.problems ?? []).map((p) => p.problem);
  assert.ok(
    problems.some((p) => /^conflict:/.test(p) && /idle/.test(p) && /speed/.test(p)),
    problems.join("\n"),
  );
  assert.deepEqual(snapshot("assets", "characters", "scenes"), before);
});
