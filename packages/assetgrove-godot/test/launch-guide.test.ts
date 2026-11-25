/**
 * The launch guide (issue #484, docs/launch-guide.md) with this pack loaded: `init`, the example's
 * profile fragment merged as the guide says (its `godot:sprite-frames` hand-off kept), the guide's
 * LFS step, its install of the pack and the pack's settings as each of its two settings blocks has
 * them, and its `extensions setup godot` line run before and after the install. Then `doctor` on
 * that profile, which needs no Godot, and, with Godot 4.7.2 on PATH (CI's setup-godot puts it
 * there), the guide's `stage-source` and `pick` of the human-made mole, which build its
 * SpriteFrames. Without Godot that test skips with the reason.
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
const packRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
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

/** The guide's JSON blocks that list the pack, in the guide's order. */
const settingsBlocks = [...guide.matchAll(/```json\n([\s\S]*?)```/g)]
  .map((block) => ({ at: block.index, json: JSON.parse(block[1]!) as Record<string, unknown> }))
  .filter((block) => Array.isArray(block.json["extensions"]));

/** The pack's settings: the guide's block `index`, its printed-path placeholder replaced. */
let block = 0;
function settings(index: number = block) {
  block = index;
  const text = JSON.stringify(settingsBlocks[index]!.json).replace(
    '"/path/printed/by/setup"',
    JSON.stringify(GODOT ?? "/path/printed/by/setup"),
  );
  project.writeSettings({ ...(JSON.parse(text) as object), commands: { approved } });
}

/** Proxy settings that make every download in the CLI fail at once, so setup never fetches Godot. */
const offline = {
  NODE_USE_ENV_PROXY: "1",
  HTTPS_PROXY: "http://127.0.0.1:9",
  https_proxy: "http://127.0.0.1:9",
  HTTP_PROXY: "http://127.0.0.1:9",
  http_proxy: "http://127.0.0.1:9",
  NO_PROXY: "",
  no_proxy: "",
};

/** Runs one of the guide's lines through the CLI, a tool run it needs approved as a person would. */
async function cli(
  line: string[],
  replace: Record<string, string> = {},
  env: Record<string, string> = {},
): Promise<CliResult> {
  const args = [...line.slice(1).map((word) => replace[word] ?? word), "--json"];
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await project.cli(args, { env });
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

let setupUninstalled: CliResult;
let setupInstalled: CliResult;

before(async () => {
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
  // The guide's settings before setup, and its setup line, without and then with the install.
  settings(0);
  const setup = guideLine("assetgrove", "extensions", "setup");
  setupUninstalled = await cli(setup, {}, offline);
  // The guide's install: the packed pack, as npm puts it, under node_modules/<name>.
  const installed = project.install(buildPack(stage), NAME);
  symlinkSync(packNodeModules, join(installed, "node_modules"), "junction");
  // The installed pack links to the pack's dependencies; Godot must not scan into them.
  writeFileSync(join(project.dir, "node_modules", ".gdignore"), "");
  setupInstalled = await cli(setup, {}, offline);
  // The path setup printed, in the guide's last settings block.
  settings(settingsBlocks.length - 1);
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

test("the guide installs this pack's own tarball from the checkout, without fetching core", () => {
  const manifest = JSON.parse(readFileSync(join(packRoot, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  const tarball = `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`;
  const pack = lines.find((line) => line.includes("pack"))!;
  assert.ok(pack, "the guide has no pack line");
  assert.equal(pack[pack.indexOf("--dir") + 1], "packages/assetgrove-godot");
  assert.ok(existsSync(join(repoRoot, "packages", "assetgrove-godot", "package.json")));
  assert.equal(pack[pack.indexOf("--pack-destination") + 1]!.replace(/\)$/, ""), "$OLDPWD/vendor");
  const install = guideLine("npm", "install");
  assert.ok(install.includes("--legacy-peer-deps"), "npm would fetch the unpublished core");
  assert.equal(install.at(-1), `./vendor/${tarball}`);
});

test("the guide's setup line refuses before the install and downloads Godot after it", () => {
  assert.equal(setupUninstalled.code, 2, setupUninstalled.stdout + setupUninstalled.stderr);
  assert.match(setupUninstalled.stdout, /extension_unavailable/);
  assert.match(setupUninstalled.stdout, /does not resolve/);
  // With the pack installed and no `godot` setting yet, setup goes to the pinned download (refused
  // here by the proxy), not the settings' "which is not a file".
  const out = setupInstalled.stdout + setupInstalled.stderr;
  assert.match(
    out,
    /Godot_v4\.7\.2-stable_[^ ]* \(version 4\.7\.2-stable\) could not be downloaded/,
  );
  assert.doesNotMatch(out, /not a file|does not resolve/);
});

test("the guide's settings name no Godot until its setup has printed the path", () => {
  assert.equal(settingsBlocks.length, 2);
  const [first, last] = settingsBlocks;
  assert.deepEqual(first!.json, { extensions: [NAME] });
  assert.deepEqual(last!.json["extensionSettings"], {
    [NAME]: { godot: "/path/printed/by/setup" },
  });
  const setupAt = guide.indexOf("assetgrove extensions setup godot");
  assert.ok(first!.at < setupAt && setupAt < last!.at);
  assert.ok(last!.at < guide.indexOf("assetgrove pick "));
});

test("the guide's setup line uses the Godot its last settings block names", async (t) => {
  if (GODOT === undefined) return t.skip(SKIP!);
  const result = await cli(guideLine("assetgrove", "extensions", "setup"));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.json?.["godot"], GODOT);
  assert.equal(result.json?.["source"], "settings");
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
