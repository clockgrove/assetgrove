/**
 * The Godot doctor (issue #483): a synthetic project with orphan and duplicate UIDs, a tracked
 * engine cache and text resources stored as LFS objects is reported with exact paths and
 * corrections, a healthy project has no findings, and nothing in the target changes. No Godot
 * binary is needed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { sampleProfile, samplePng, tempProject } from "@clockgrove/assetgrove/testing";
import type { DoctorContext } from "@clockgrove/assetgrove/extension";
import { godotDoctor } from "../src/doctor.ts";
import godotExtension from "../src/extension.ts";

const projects: Array<{ close(): void }> = [];
const profiles = realpathSync(mkdtempSync(join(tmpdir(), "godot-doctor-")));
after(() => {
  projects.forEach((p) => p.close());
  rmSync(profiles, { recursive: true, force: true });
});

function fresh() {
  const project = tempProject();
  projects.push(project);
  const put = (path: string, content: string | Uint8Array) => {
    const full = join(project.dir, ...path.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: project.dir, stdio: "ignore" });
  const profilePath = join(profiles, `profile-${projects.length}.json`);
  const run = async (project_: string) => {
    const handoff = ["godot:sprite-frames", "godot:gltf"].map((preset) => ({
      preset,
      options: { project: project_ },
    }));
    writeFileSync(profilePath, JSON.stringify(sampleProfile({ handoff: handoff as never })));
    return project.run(
      "doctor",
      { profile: profilePath, target: project.dir },
      { extensions: [godotExtension] },
    );
  };
  return { project, put, git, run };
}

interface Found {
  code: string;
  path: string;
  line?: number;
  problem: string;
  correction: string;
  presets: string[];
}
const findingsOf = (outcome: { fields?: unknown }) =>
  (outcome.fields as { findings: Found[] }).findings;

/** Every file under `dir`, `.git` included, with its hash. */
function hashAll(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, hashAll(full, base));
    else
      out[full.slice(base.length)] = createHash("sha256").update(readFileSync(full)).digest("hex");
  }
  return out;
}

const scene = (uid: string, ...externals: string[]) =>
  `[gd_scene load_steps=2 format=3 uid="${uid}"]\n\n${externals.join("\n")}\n\n[node name="Root" type="Node2D"]\n`;
const importFile = (uid: string) =>
  `[remap]\n\nimporter="texture"\ntype="CompressedTexture2D"\nuid="${uid}"\n`;

test("a broken project is reported with exact paths and corrections, and left unchanged", async () => {
  const { project, put, git, run } = fresh();
  put("game/project.godot", "config_version=5\n");
  put("game/scripts/gone.gd.uid", "uid://orphan1\n");
  put("game/art/missing.png.import", importFile("uid://missingpng"));
  put("game/art/hero.png", samplePng());
  put("game/art/hero.png.import", importFile("uid://hero1"));
  put(
    "game/scenes/main.tscn",
    scene(
      "uid://main1",
      '[ext_resource type="Texture2D" uid="uid://oldhero" path="res://art/hero.png" id="1"]',
      // An LFS pointer's UID cannot be read, so the reference is not called an orphan.
      '[ext_resource type="PackedScene" uid="uid://level1" path="res://levels/level.tscn" id="2"]',
    ),
  );
  put("game/art/hero2.png", samplePng());
  put(
    "game/art/hero2.png.import",
    `${importFile("uid://hero1")}path="res://.godot/imported/hero2.ctex"\n\n[params]\n\ncompress/mode=0\n`,
  );
  put("game/a.gd", "extends Node\n");
  put("game/a.gd.uid", "uid://same1\n");
  put("game/b.gd", "extends Node\n");
  put("game/b.gd.uid", "uid://same1\n");
  put("game/.godot/imported/x.ctex", "cache");
  put("game/.godot/uid_cache.bin", "cache");
  put("game/res/theme.tres", '[gd_resource type="Theme" format=3 uid="uid://theme1"]\n');
  put(
    "game/levels/level.tscn",
    "version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 3\n",
  );
  put(".gitattributes", "*.tres filter=lfs diff=lfs merge=lfs -text\n");
  put("game/.gitattributes", "*.tres filter=lfs diff=lfs merge=lfs -text\n");
  git("add", "-f", "game/.godot/imported/x.ctex", "game/.godot/uid_cache.bin");

  const before = hashAll(project.dir);
  const outcome = await run("game");
  assert.deepEqual(hashAll(project.dir), before);
  assert.equal(outcome.exitCode, 0, outcome.human);
  const errors = (outcome.fields as { errors: unknown[] }).errors;
  assert.deepEqual(errors, []);

  const found = findingsOf(outcome);
  assert.deepEqual(
    found.map((f) => [f.code, f.path, f.line]),
    [
      ["duplicate-uid", "game/art/hero2.png.import", undefined],
      ["duplicate-uid", "game/b.gd.uid", undefined],
      ["tracked-engine-cache", "game/.godot", undefined],
      ["orphan-uid", "game/art/missing.png.import", undefined],
      ["lfs-text-resource", "game/levels/level.tscn", undefined],
      ["lfs-text-resource", "game/res/theme.tres", undefined],
      ["orphan-uid", "game/scenes/main.tscn", 3],
      ["orphan-uid", "game/scripts/gone.gd.uid", undefined],
    ].sort((a, b) => (a[1]! < b[1]! ? -1 : 1)) as never,
  );
  for (const f of found) {
    assert.ok(f.correction.includes(f.path), f.correction);
    assert.deepEqual(f.presets, ["godot:sprite-frames", "godot:gltf"]);
    assert.ok(outcome.human.includes(f.path));
  }
  const by = (code: string, path: string) => found.find((f) => f.code === code && f.path === path)!;
  const stale = by("orphan-uid", "game/scenes/main.tscn");
  assert.match(stale.correction, /uid:\/\/oldhero/);
  assert.match(stale.correction, /uid:\/\/hero1/);
  assert.match(stale.correction, /line 3/);
  assert.match(by("orphan-uid", "game/scripts/gone.gd.uid").correction, /game\/scripts\/gone\.gd/);
  assert.match(by("tracked-engine-cache", "game/.godot").problem, /2 files/);
  assert.match(
    by("tracked-engine-cache", "game/.godot").correction,
    /git rm -r --cached -- game\/\.godot.*game\/\.gitignore/,
  );
  assert.match(
    by("lfs-text-resource", "game/res/theme.tres").correction,
    /-filter -diff -merge text/,
  );
  assert.match(by("lfs-text-resource", "game/res/theme.tres").correction, /git add --renormalize/);
  assert.match(by("lfs-text-resource", "game/levels/level.tscn").correction, /git lfs pull/);

  const copy = by("duplicate-uid", "game/art/hero2.png.import").correction;
  assert.match(copy, /remove only the line uid="uid:\/\/hero1" under \[remap\]/);
  assert.match(copy, /keeping its other import options/);
  assert.doesNotMatch(copy, /delete/);
  assert.match(by("duplicate-uid", "game/b.gd.uid").correction, /delete game\/b\.gd\.uid/);

  // The corrections, applied as written, clear their findings; a deeper .gitattributes rule
  // routing the file to LFS is overridden by the one the correction names.
  const [, attribute, attributesFile] = /add the line "([^"]+)" to the end of (\S+)/.exec(
    by("lfs-text-resource", "game/res/theme.tres").correction,
  )!;
  assert.equal(attributesFile, "game/res/.gitattributes");
  put(attributesFile!, `${attribute}\n`);
  git("rm", "-r", "--cached", "--quiet", "--", "game/.godot");
  put("game/.gitignore", ".godot/\n");
  const after = findingsOf(await run("game")).map((f) => [f.code, f.path]);
  assert.ok(!after.some(([, path]) => path === "game/res/theme.tres" || path === "game/.godot"));
  assert.equal(
    execFileSync("git", ["check-attr", "filter", "--", "game/res/theme.tres"], {
      cwd: project.dir,
      encoding: "utf8",
    }).trim(),
    "game/res/theme.tres: filter: unset",
  );
});

test("a healthy project has no findings", async () => {
  const { project, put, run } = fresh();
  put("game/project.godot", "config_version=5\n");
  put("game/art/hero.png", samplePng());
  put("game/art/hero.png.import", importFile("uid://hero1"));
  put("game/hero.gd", "extends Node\n");
  put("game/hero.gd.uid", "uid://script1\n");
  put(
    "game/main.tscn",
    scene(
      "uid://main1",
      '[ext_resource type="Texture2D" uid="uid://hero1" path="res://art/hero.png" id="1"]',
      '[ext_resource type="Script" uid="uid://script1" path="res://hero.gd" id="2"]',
    ),
  );
  // A binary resource carries its UID inside, where the doctor cannot read it.
  put("game/mesh.res", new Uint8Array([0x52, 0x53, 0x43, 0x43, 0, 1, 2, 3]));
  put(
    "game/level.tscn",
    scene(
      "uid://level1",
      '[ext_resource type="ArrayMesh" uid="uid://mesh1" path="res://mesh.res" id="1"]',
    ),
  );
  // A source that is a link to a file of the target is not missing.
  put("game/shared/real.png", samplePng());
  put("game/shared/real.png.import", importFile("uid://real1"));
  symlinkSync(join(project.dir, "game/shared/real.png"), join(project.dir, "game/art/link.png"));
  put("game/art/link.png.import", importFile("uid://link1"));
  put("game/.gitignore", ".godot/\n");
  put(".gitattributes", "*.png filter=lfs diff=lfs merge=lfs -text\n");
  put("game/.godot/uid_cache.bin", "cache");
  const outcome = await run("game");
  assert.deepEqual(findingsOf(outcome), []);
  assert.deepEqual((outcome.fields as { errors: unknown[] }).errors, []);
  assert.match(outcome.human, /no findings/);
});

test("files outside the project folder are not reported, and a target without project.godot has no findings", async () => {
  const { project, put, run } = fresh();
  put("game/project.godot", "config_version=5\n");
  put("other/project.godot", "config_version=5\n");
  put("other/orphan.gd.uid", "uid://other1\n");
  const before = hashAll(project.dir);
  assert.deepEqual(findingsOf(await run("game")), []);
  assert.deepEqual(hashAll(project.dir), before);
  const none = await run("nowhere");
  assert.deepEqual(findingsOf(none), []);
  const reported = findingsOf(await run("other"));
  assert.deepEqual(
    reported.map((f) => f.path),
    ["other/orphan.gd.uid"],
  );
});

test("a tracked cache is only untracked when .gitignore already ignores it", async () => {
  const files = ["project.godot", ".gitignore", ".godot/a"];
  const ctx = (ignore: string): [DoctorContext, (p: string) => Promise<Uint8Array>] => [
    {
      profile: sampleProfile(),
      list: async () => files.map((path) => ({ path, size: 1, mtimeMs: 0, ctimeMs: 0 })) as never,
      tracked: async () => [".godot/a"],
      lfs: async () => [],
    },
    async (path) => {
      if (path === ".gitignore") return new TextEncoder().encode(ignore);
      return new Uint8Array();
    },
  ];
  const [c1, r1] = ctx("/.godot/\n");
  const [only] = await godotDoctor(c1, "", r1);
  assert.equal(only!.path, ".godot");
  assert.doesNotMatch(only!.correction, /gitignore/);
  const [c2, r2] = ctx("*.tmp\n");
  const [both] = await godotDoctor(c2, "", r2);
  assert.match(both!.correction, /add \.godot\/ to \.gitignore/);
});
