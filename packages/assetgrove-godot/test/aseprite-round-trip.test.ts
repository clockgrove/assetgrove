/**
 * An editable Aseprite source through a Godot re-export (issue #470): the developer's `.aseprite`
 * file is staged with `stage-source` and picked with `godot:sprite-frames`; in Godot they add an
 * animation, a scene and an import option; then they edit the source, and a new stage and pick of
 * it is a new version of the same asset, with lineage naming the edited source, while their
 * animation, scene, the SpriteFrames UID and the import settings survive. These tests need Godot
 * 4.7.2 on PATH (CI's setup-godot puts it there), and without it each test skips with the reason.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fernAseprite, sampleProfile, tempProject } from "@clockgrove/assetgrove/testing";
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
/** The editable source, inside the library root (`assets`) so its lineage path is portable. */
const SOURCE = "assets/source/fern.aseprite";
const IMPORTS = ["assets/fern-idle.png.import", "art/hurt.png.import"];

const stage = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-godot-aseprite-")));
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

/** Stages the project's source as it is now and picks its one candidate. */
async function stageAndPick(): Promise<{ sourceSha256: string; picked: CliResult }> {
  const staged = await project.cli([
    ...["stage-source", "--source", join(project.dir, SOURCE)],
    ...["--spec", join(stage, "spec.json"), "--profile", join(stage, "profile.json")],
    ...["--runs", join(stage, "runs"), "--digital-source-type", "digitalCreation", "--json"],
  ]);
  assert.equal(staged.code, 0, staged.stderr + staged.stdout);
  const picked = await approving([
    ...["pick", "--run", String(staged.json?.["runDir"]), "--candidate", "c1"],
    ...["--target", project.dir, "--json"],
  ]);
  const source = staged.json?.["editableSource"] as { sha256: string };
  return { sourceSha256: source.sha256, picked };
}

const godot = (...args: string[]) =>
  spawnSync(GODOT!, ["--headless", "--path", project.dir, ...args], {
    encoding: "utf8",
    // A script that stops on an error never reaches quit(), and headless Godot then waits forever.
    timeout: 180_000,
  });

/** Runs a script in the project with Godot and returns what it printed, failing on an ERROR. */
function run(script: string): string {
  const result = godot("--script", script);
  const out = result.stdout + result.stderr;
  assert.equal(result.error, undefined, `${String(result.error)}\n${out}`);
  assert.equal(result.status, 0, out);
  assert.doesNotMatch(out, /ERROR/);
  return out;
}

/** The asset's review versions: each version's media sha256 and lineage. */
function versions(review: string): Array<{ sha256: string; lineage?: unknown }> {
  return (JSON.parse(text(review)) as { "ag:versions": Array<{ sha256: string; lineage?: unknown }> })[
    "ag:versions"
  ];
}

before(() => {
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
  // pick refuses media Git would not store in LFS.
  writeFileSync(
    join(project.dir, ".gitattributes"),
    "*.png filter=lfs diff=lfs merge=lfs -text\n*.review.json merge=union\n",
  );
  mkdirSync(join(project.dir, "assets", "source"), { recursive: true });
  writeFileSync(join(project.dir, SOURCE), fernAseprite());
  git("add", "project.godot", ".gitattributes", SOURCE);
  git("commit", "--quiet", "-m", "a godot project and the developer's aseprite source");
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
  writeFileSync(join(stage, "profile.json"), JSON.stringify(profile));
  writeFileSync(
    join(stage, "spec.json"),
    JSON.stringify({ kind: "sprite-strip", assetId: "fern", animationFamily: "idle" }),
  );
});

let firstUid: string | undefined;
let firstSource = "";
let review = "";
let imports = new Map<string, Buffer>();
let scene = Buffer.alloc(0);
let idleStrip = Buffer.alloc(0);

test("the Aseprite source's idle tag is staged and picked into Godot with its lineage", async (t) => {
  if (!usable) return t.skip(SKIP!);
  const { sourceSha256, picked } = await stageAndPick();
  assert.equal(picked.code, 0, picked.stderr + picked.stdout);
  firstSource = sourceSha256;
  const library = picked.json?.["library"] as { files: string[] };
  review = library.files.find((f) => f.endsWith(".review.json"))!;
  assert.ok(review, JSON.stringify(library.files));
  assert.deepEqual(
    versions(review).map((v) => v.lineage),
    [[{ relation: "derived-from", file: "source/fern.aseprite", sha256: firstSource }]],
  );
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

test("an edited source picks as a new version of fern and the developer's Godot data survives", async (t) => {
  if (!usable) return t.skip(SKIP!);
  writeFileSync(join(project.dir, SOURCE), fernAseprite({ edited: true }));
  git("add", SOURCE);
  git("commit", "--quiet", "-m", "the developer edits the idle frames");

  const { sourceSha256, picked } = await stageAndPick();
  assert.equal(picked.code, 0, picked.stderr + picked.stdout);
  assert.notEqual(sourceSha256, firstSource);
  const library = picked.json?.["library"] as { assetId: string; version: number };
  assert.equal(library.version, 2);
  const stack = versions(review);
  assert.deepEqual(
    stack.map((v) => v.lineage),
    [
      [{ relation: "derived-from", file: "source/fern.aseprite", sha256: firstSource }],
      [{ relation: "derived-from", file: "source/fern.aseprite", sha256: sourceSha256 }],
    ],
  );
  const relations = await project.cli([
    ...["library", "relations", "--target", project.dir],
    ...["--profile", join(stage, "profile.json"), "--json"],
  ]);
  assert.equal(relations.code, 0, relations.stderr + relations.stdout);
  const changed = relations.json?.["changedSources"] as Array<{
    downstream: { sha256: string };
    currentSha256: string | null;
  }>;
  assert.deepEqual(
    changed.map((e) => [e.downstream.sha256, e.currentSha256]),
    [[stack[0]!.sha256, sourceSha256]],
  );

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
  assert.deepEqual(anims, ["hurt 2", "idle 4"]);
  assert.match(out, /^PLAYER blink$/m);
  assert.match(out, /^CURRENT idle$/m);
});
