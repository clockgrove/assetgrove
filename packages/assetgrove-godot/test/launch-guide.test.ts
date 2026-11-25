/**
 * The launch guide (issue #484, docs/launch-guide.md) with this pack loaded: `init`, the example's
 * profile fragment merged as the guide says (its `godot:sprite-frames` hand-off kept), the guide's
 * LFS step and the pack's settings, then `doctor` on that profile, which needs no Godot, and, with
 * Godot 4.7.2 on PATH (CI's setup-godot puts it there), the guide's `stage-source` and `pick` of the
 * human-made mole, which build its SpriteFrames. Without Godot that test skips with the reason.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { asepriteFile, tempProject } from "@clockgrove/assetgrove/testing";
import type { CliResult } from "@clockgrove/assetgrove/testing";
import godotExtension from "../src/extension.ts";
import { findGodot } from "./helpers/godot.ts";
import { buildPack, packNodeModules } from "./helpers/pack.ts";

const NAME = "@clockgrove/assetgrove-godot";
const { godot: GODOT, skip: SKIP } = findGodot();
const docs = fileURLToPath(new URL("../../../docs/", import.meta.url));
const example = join(docs, "examples", "launch");
const guide = readFileSync(join(docs, "launch-guide.md"), "utf8").replace(/\r\n/g, "\n");

/** The guide's shell lines, continuations joined, each split into words (double quotes kept together). */
const lines: string[][] = [];
for (const block of guide.matchAll(/```sh\n([\s\S]*?)```/g))
  for (const line of block[1]!.replace(/\\\n\s*/g, " ").split("\n"))
    if (line.trim() !== "")
      lines.push([...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]!));

function guideLine(...words: string[]): string[] {
  const found = lines.filter((line) => words.every((word, i) => line[i] === word));
  assert.equal(found.length, 1, `the guide has ${found.length} \`${words.join(" ")}\` lines`);
  return found[0]!;
}

const stage = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-godot-launch-")));
const project = tempProject();
const approved: Array<Record<string, unknown>> = [];
const profilePath = join(project.dir, ".assetgrove", "profile.json");

after(() => {
  project.close();
  rmSync(stage, { recursive: true, force: true });
});

const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: project.dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/** The pack's settings as the guide's JSON block lists them, with the Godot path filled in. */
function settings() {
  project.writeSettings({
    extensions: [NAME],
    extensionSettings: { [NAME]: { godot: GODOT ?? "/path/printed/by/setup" } },
    commands: { approved },
  });
}

/** Runs one of the guide's lines through the CLI, a tool run it needs approved as a person would. */
async function cli(line: string[], replace: Record<string, string> = {}): Promise<CliResult> {
  const args = [...line.slice(1).map((word) => replace[word] ?? word), "--json"];
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await project.cli(args);
    if (result.code !== 8) return result;
    const error = (result.json?.["error"] as { confirmation?: { command?: object } }) ?? {};
    const command = error.confirmation?.command as { hash: string; argv: string[] } | undefined;
    assert.ok(command, result.stdout + result.stderr);
    approved.push({ hash: command.hash, kind: "tool", argv: command.argv, note: "guide test" });
    settings();
  }
  throw new Error("the approval did not hold");
}

/** A person's 32 x 32 Aseprite file with a `walk` tag over four frames, as the guide's mole. */
function moleAseprite(): Uint8Array {
  const frames = Array.from({ length: 4 }, (_, f) => {
    const rgba = new Uint8Array(32 * 32 * 4);
    for (let y = 8 + (f % 2); y < 28; y++)
      for (let x = 8 + f; x < 20 + f; x++) rgba.set([110, 80, 60, 255], (y * 32 + x) * 4);
    return { durationMs: 125, cels: [{ layer: 0, x: 0, y: 0, width: 32, height: 32, rgba }] };
  });
  return asepriteFile({
    width: 32,
    height: 32,
    layers: [{ name: "body" }],
    frames,
    tags: [{ name: "walk", from: 0, to: 3 }],
  });
}

before(async () => {
  if (GODOT !== undefined) {
    const installed = project.install(buildPack(stage), NAME);
    symlinkSync(packNodeModules, join(installed, "node_modules"), "junction");
    // The installed pack links to the pack's dependencies; Godot must not scan into them.
    writeFileSync(join(project.dir, "node_modules", ".gdignore"), "");
  }
  const init = await cli(guideLine("assetgrove", "init"));
  assert.equal(init.code, 0, init.stdout + init.stderr);
  // The guide's merge: each top-level field of the fragment over init's profile.
  const fragment = JSON.parse(readFileSync(join(example, "profile-fragment.json"), "utf8"));
  const profile = { ...JSON.parse(readFileSync(profilePath, "utf8")), ...fragment };
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  // The guide's LFS step.
  mkdirSync(join(project.dir, guideLine("mkdir", "-p")[2]!), { recursive: true });
  const mv = guideLine("mv");
  renameSync(join(project.dir, mv[1]!), join(project.dir, mv[2]!));
  settings();
  writeFileSync(
    join(project.dir, "game", "project.godot"),
    'config_version=5\n\n[application]\n\nconfig/name="Demo Garden"\n',
  );
  writeFileSync(join(project.dir, "mole-walk.json"), readFileSync(join(example, "mole-walk.json")));
  const stageLine = guideLine("assetgrove", "stage-source");
  const source = join(project.dir, stageLine[stageLine.indexOf("--source") + 1]!);
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, moleAseprite());
  git("add", "-A");
  git("commit", "--quiet", "-m", "the guide's setup");
});

test("the guide sets the pack up before its first pick", () => {
  assert.ok(guide.indexOf("extensions setup godot") < guide.indexOf("assetgrove pick "));
  assert.ok(guide.indexOf(`"extensions": ["${NAME}"]`) < guide.indexOf("assetgrove pick "));
});

test("doctor reads the guide's profile with the pack loaded and finds nothing wrong", async () => {
  const doctor = guideLine("assetgrove", "doctor");
  const outcome = await project.run(
    "doctor",
    { profile: join(project.dir, doctor[doctor.indexOf("--profile") + 1]!), target: project.dir },
    { extensions: [godotExtension] },
  );
  assert.equal(outcome.exitCode, 0, outcome.human);
  assert.deepEqual((outcome.fields as { errors: unknown[] }).errors, []);
  assert.deepEqual((outcome.fields as { findings: unknown[] }).findings, []);
});

test("the guide's stage-source and pick of the mole build its SpriteFrames in Godot", async (t) => {
  if (GODOT === undefined) return t.skip(SKIP!);
  const staged = await cli(guideLine("assetgrove", "stage-source"));
  assert.equal(staged.code, 0, staged.stdout + staged.stderr);
  const run = relative(join(project.dir, ".assetgrove", "runs"), String(staged.json?.["runDir"]));
  const pick = lines.filter((line) => line[1] === "pick").at(-1)!;
  const picked = await cli(pick, { ".assetgrove/runs/<run>": `.assetgrove/runs/${run}` });
  assert.equal(picked.code, 0, picked.stdout + picked.stderr);
  for (const file of ["game/assets/mole/walk.png", "game/characters/mole.tres"])
    assert.ok(existsSync(join(project.dir, file)), `${file} was not written`);
  const manifest = JSON.parse(
    readFileSync(join(project.dir, "assets", "manifests", "mole", "walk.json"), "utf8"),
  ) as { source: Record<string, unknown> };
  assert.equal(
    manifest.source["digitalSourceType"],
    "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation",
  );
});
