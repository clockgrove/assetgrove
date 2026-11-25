/**
 * The replacement preview with the real Godot pack (issue #469): a picked asset sits in a Godot
 * project beside the scenes and resources that use it, a second run replaces it, and core's `pick`
 * request lists the pack's known usage and marks what it could not resolve or read, without
 * writing anything to the project. No Godot binary is needed: the preview only reads.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  bibleMarkdown,
  sampleBible,
  sampleProfile,
  samplePng,
  tempProject,
} from "@clockgrove/assetgrove/testing";
import type { RunOptions } from "@clockgrove/assetgrove/testing";
import godotExtension from "../src/extension.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "usage");
type ConfirmRequest = Parameters<NonNullable<RunOptions["confirm"]>>[0];
const route = {
  provider: "scripted",
  model: "scripted/still",
  estimatedCostUsd: 0.01,
  outputGrant: { license: "MIT", plan: "api", commercial: true, relabel: true },
};
const stage = realpathSync(mkdtempSync(join(tmpdir(), "godot-usage-preview-")));
const project = tempProject();

const git = (...args: string[]) => execFileSync("git", args, { cwd: project.dir, stdio: "ignore" });

before(() => {
  // Core hands media off only where Git would store it in LFS.
  writeFileSync(join(project.dir, ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n");
  git("add", ".gitattributes");
  git("commit", "--quiet", "-m", "route png to LFS");
  project.writeSettings({ roles: { image: route, decisions: route } }, { attended: true });
});
after(() => {
  project.close();
  rmSync(stage, { recursive: true, force: true });
});

/** The run that replaces `fern`, staged by the first test and previewed again by the later ones. */
let second = "";

/** Core's real `pick` preview of `second`: the confirmation request it shows, declined. */
async function preview(): Promise<ConfirmRequest> {
  const requests: ConfirmRequest[] = [];
  const declined = await project.run(
    "pick",
    { run: second, candidate: "c1", target: project.dir },
    {
      extensions: [godotExtension],
      confirm: (request) => {
        requests.push(request);
        return false;
      },
    },
  );
  assert.notEqual(declined.exitCode, 0, declined.human);
  assert.equal(requests.length, 1);
  return requests[0]!;
}

const hudFiles = (request: ConfirmRequest) =>
  (
    request.details["usage"] as Array<{ report: { references: Array<{ file: string }> } }>
  )[0]!.report.references.filter((r) => r.file === "game/ui/hud.tscn").length;

/** Stages a `still` of the asset `fern` whose image is a PNG of `size` px, under `handoff`. */
async function stageRun(n: number, size: number, handoff: unknown[]): Promise<string> {
  const dir = join(stage, `run-${n}`);
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from(samplePng(size)).toString("base64");
  const script = join(dir, "script.mjs");
  writeFileSync(
    script,
    `const bytes = Buffer.from(${JSON.stringify(bytes)}, "base64");
export default {
  image: () => ({ images: [{ mediaType: "image/png", bytes }] }),
  vision: () => ({ text: "{}" }),
  decide: () => ({ answer: { type: "boolean", probability: 0.1 } }),
};
`,
  );
  const write = (name: string, content: string) => {
    writeFileSync(join(dir, name), content);
    return join(dir, name);
  };
  mkdirSync(join(dir, "refs"), { recursive: true });
  for (const name of ["fern", "perspective"])
    writeFileSync(join(dir, "refs", `${name}.png`), samplePng());
  const bible = sampleBible({
    references: [
      { path: "refs/fern.png", role: "character sheet", subject: "fern" },
      { path: "refs/perspective.png", role: "perspective" },
    ],
    subjects: { fern: { description: "a synthetic fern" } },
  });
  const profile = sampleProfile({
    layout: {
      media: "game/characters/{{spec.assetId}}.{{output.extension}}",
      manifest: "game/manifests/{{spec.assetId}}.json",
    },
    handoff: handoff as never,
  });
  const outcome = await project.run(
    "stage",
    {
      spec: write("spec.json", JSON.stringify({ kind: "still", assetId: "fern" })),
      bible: write("BIBLE.md", bibleMarkdown(bible)),
      profile: write("profile.json", JSON.stringify(profile)),
      runs: join(dir, "runs"),
      providerScript: script,
      candidates: 1,
    },
    { confirm: () => true },
  );
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.error) + outcome.human);
  return String(outcome.fields["runDir"]);
}

interface Listed {
  path: string;
  size: number;
  mtimeMs: number;
}

function listing(dir: string, rel = ""): Listed[] {
  const out: Listed[] = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    if (rel === "" && entry.name === ".git") continue;
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listing(dir, path));
    else {
      const s = statSync(join(dir, path));
      out.push({ path, size: s.size, mtimeMs: s.mtimeMs });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

test("the replacement preview lists the Godot pack's known usage and leaves the project as it was", async () => {
  const first = await stageRun(1, 8, [{ preset: "manifest" }]);
  const picked = await project.run(
    "pick",
    { run: first, candidate: "c1", target: project.dir },
    { confirm: () => true },
  );
  assert.equal(picked.exitCode, 0, JSON.stringify(picked.error) + picked.human);
  assert.ok(statSync(join(project.dir, "game/characters/fern.png")).isFile());

  // What a developer's project holds beside the media: Godot's import file, scenes and resources.
  cpSync(FIXTURE, join(project.dir, "game"), { recursive: true });
  writeFileSync(join(project.dir, "game/characters/rock.png"), new Uint8Array([0x89, 0x50]));
  writeFileSync(join(project.dir, "game/scenes/old.scn"), new Uint8Array([0x52, 0x53, 0x43, 0x4e]));
  assert.match(
    readFileSync(join(project.dir, "game/characters/fern.png.import"), "utf8"),
    /uid="uid:\/\/b1fern"/,
  );
  git("add", "-A");
  git("commit", "--quiet", "-m", "the game uses fern");

  second = await stageRun(2, 12, [
    { preset: "manifest" },
    { preset: "godot:sprite-frames", options: { project: "game" } },
  ]);
  const before = listing(project.dir);
  const requests: ConfirmRequest[] = [];
  const declined = await project.run(
    "pick",
    { run: second, candidate: "c1", target: project.dir },
    {
      extensions: [godotExtension],
      confirm: (request) => {
        requests.push(request);
        return false;
      },
    },
  );
  assert.notEqual(declined.exitCode, 0, declined.human);
  assert.equal(requests.length, 1);
  const request = requests[0]!;

  const usage = request.details["usage"] as Array<{ preset: string; report: unknown }>;
  assert.equal(usage.length, 1);
  assert.equal(usage[0]!.preset, "godot:sprite-frames");
  assert.deepEqual(usage[0]!.report, {
    asset: { path: "res://characters/fern.png", uid: "uid://b1fern" },
    references: [
      {
        file: "game/resources/fern_frames.tres",
        line: 3,
        path: "res://characters/fern.png",
        status: "resolved",
        locations: [`sub_resource "AtlasTexture_a" atlas`],
      },
      {
        file: "game/resources/theme.tres",
        line: 3,
        path: "res://missing/gone.png",
        uid: "uid://b1gone",
        status: "unresolved",
        locations: ["resource icon"],
        reason: "its UID and path resolve to nothing in the project",
      },
      {
        file: "game/scenes/level.tscn",
        line: 3,
        path: "res://characters/fern.png",
        uid: "uid://b1fern",
        status: "resolved",
        locations: [`node "Level/Player/Sprite" texture`],
      },
      {
        file: "game/scenes/menu.tscn",
        line: 3,
        path: "res://old/fern.png",
        uid: "uid://b1fern",
        status: "resolved",
        locations: [`node "Menu/Icon" texture`],
      },
      {
        file: "game/scenes/old.scn",
        status: "unreadable",
        locations: [],
        reason: "a binary resource, which the scan does not read",
      },
      {
        file: "game/ui/hud.tscn",
        line: 4,
        path: "res://characters/fern.png",
        status: "resolved",
        locations: [`node "Hud" metadata/portrait`],
      },
    ],
  });

  assert.match(request.summary, /; known usage \(godot:sprite-frames\): /);
  assert.match(request.summary, /game\/scenes\/level\.tscn:3 res:\/\/characters\/fern\.png/);
  assert.match(request.summary, /; UNRESOLVED game\/resources\/theme\.tres:3 /);
  assert.match(request.summary, /; UNREADABLE game\/scenes\/old\.scn /);

  assert.deepEqual(listing(project.dir), before);
  assert.ok(readdirSync(join(project.stateDir, "cache", "usage")).length > 0);
});

test("assetgrove confirm shows the known usage of the pick a person declined", async () => {
  const shown = await preview();
  const requests: ConfirmRequest[] = [];
  const confirmed = await project.run(
    "confirm",
    { id: shown.id },
    {
      extensions: [godotExtension],
      confirm: (request) => {
        requests.push(request);
        return false;
      },
    },
  );
  assert.equal(confirmed.error?.code, "confirmation_declined", confirmed.human);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.id, shown.id);
  assert.deepEqual(requests[0]!.details["usage"], shown.details["usage"]);
  assert.match(requests[0]!.summary, /; UNRESOLVED game\/resources\/theme\.tres:3 /);
  assert.match(requests[0]!.summary, /; UNREADABLE game\/scenes\/old\.scn /);
});

test("a second preview re-reads a file after an edit and every file after a new commit", async () => {
  const cacheDir = join(project.stateDir, "cache", "usage");
  // Each cached parse is marked as finding nothing in hud.tscn: a preview that reuses the cache
  // loses hud's reference, and one that re-reads hud finds it again.
  const poison = () => {
    const files = readdirSync(cacheDir);
    assert.equal(files.length, 1);
    const path = join(cacheDir, files[0]!);
    const cached = JSON.parse(readFileSync(path, "utf8")) as {
      files: Record<string, { parsed: unknown }>;
    };
    cached.files["game/ui/hud.tscn"]!.parsed = { externals: [], literals: [] };
    writeFileSync(path, JSON.stringify(cached));
  };
  assert.equal(hudFiles(await preview()), 1);

  poison();
  assert.equal(hudFiles(await preview()), 0, "the unchanged file is taken from the cache");

  const hud = join(project.dir, "game/ui/hud.tscn");
  writeFileSync(hud, `${readFileSync(hud, "utf8")}metadata/note = "edited"\n`);
  assert.equal(hudFiles(await preview()), 1, "the edited file is read again");

  git("add", "-A");
  git("commit", "--quiet", "-m", "edit the hud");
  poison();
  assert.equal(hudFiles(await preview()), 1, "a new commit reads every file again");
});
