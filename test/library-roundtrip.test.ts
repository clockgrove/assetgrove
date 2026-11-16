/**
 * The Phase 2 gate's round trip (issue #244), run through the real CLI on the scripted provider in
 * a temporary Git repository. A library is built by real stages and picks (two stills, a sprite
 * strip, a 3D asset); a person's change is requested on a box region and a mask file of a still,
 * on a frame of the strip and on a view of the 3D asset; each request's answer is picked and each
 * new version approved. Then `library check` passes, and after every index.md and log.md is
 * deleted and a card's machine field is hand-edited, `library rebuild` reproduces every projection
 * byte for byte, and a second rebuild changes nothing.
 */
import "./fixtures/env.ts";
import { approve, useAttended } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { confirmCommand } from "../src/commands/confirm.ts";
import { runCommand } from "../src/commands/runner.ts";
import type { ConfirmPort } from "../src/confirm/prompt.ts";
import { createRaster, encodePng, setPixel } from "../src/image/raster.ts";
import { parseReview, versionStatus } from "../src/library/review.ts";
import type { ReviewRecord } from "../src/library/review.ts";
import { loadSettings } from "../src/settings.ts";
import type { AssetSpec } from "../src/types.ts";
import { gitTarget } from "./fixtures/git.ts";
import { PALETTE, drawSubject, syntheticWorld } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const STILL_SCRIPT = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
const SCRIPT_3D = fileURLToPath(new URL("./fixtures/model3d-script.ts", import.meta.url));
approve(STILL_SCRIPT, SCRIPT_3D);

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

// Run from the target: a region's mask file must lie inside the project root, which is the cwd.
let cwd = root;
function cli(args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env["AI_GATEWAY_API_KEY"];
    const child = execFile(
      process.execPath,
      [join(root, "src/cli.ts"), ...args],
      { cwd, env },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

const doc = (result: Result): Doc => JSON.parse(result.stdout);

async function ok(args: string[]): Promise<Doc> {
  const result = await cli([...args, "--json"]);
  assert.equal(result.code, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
  return doc(result);
}

/** Confirms a pending request at the terminal, as a person would. */
async function confirm(id: string): Promise<void> {
  const port: ConfirmPort = {
    method: "tty",
    confirm: async () => true,
    choose: async (r) => r.choices?.[0],
  };
  const done = await runCommand(
    confirmCommand,
    { id },
    { settings: loadSettings(), log: () => {}, prompt: port },
  );
  assert.equal(done.exitCode, 0, done.error?.message);
}

/** The command asks (exit 8), a person confirms, it runs again. */
async function confirmed(args: string[]): Promise<Doc> {
  const asked = await cli([...args, "--json"]);
  assert.equal(asked.code, 8, asked.stdout + asked.stderr);
  await confirm(doc(asked)["error"].confirmation.id as string);
  return ok(args);
}

/** Every index.md, log.md and card under `dir`, with its text. */
async function projections(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true })) {
    const name = entry.toString();
    if (name.endsWith(".md")) out[name] = await readFile(join(dir, name), "utf8");
  }
  return out;
}

test("a library of stills, a strip and a 3D asset takes four requested changes, answers and approvals, then checks and rebuilds byte for byte", async () => {
  const world = await syntheticWorld();
  const target = gitTarget(world.targetDir);
  const dir = world.dir;
  cwd = target;
  const library = join(target, "assets");
  const runs = world.runsDir;

  // One profile for every kind: stills and strips use the frame grid, the 3D asset the model3d block.
  const profilePath = join(dir, "profile.json");
  Object.assign(world.profile, {
    frames: { width: 32, height: 32, durationMs: 100 },
    model3d: {
      format: "glb",
      budgets: { triangles: 40000, textureMaxPx: 2048, materials: 4, bones: 80, lods: 1 },
      forward: "+z",
      units: "m",
      turntable: { sizePx: 96 },
    },
    layout: {
      media: "assets/{{spec.assetId}}.{{output.extension}}",
      manifest: "manifests/{{spec.assetId}}.json",
    },
    manifest: {
      assetId: "{{spec.assetId}}",
      review: { status: "pending" },
      contentHash: "{{output.sha256}}",
    },
    review: { path: "review.status", pending: "pending" },
    library: { root: "assets", game: "test-grove" },
  });
  delete world.profile.validator;
  await writeFile(profilePath, JSON.stringify(world.profile));
  const bible = join(world.bibleDir, "bible.json");
  await writeFile(bible, JSON.stringify(world.bible));

  // A bible for the 3D asset: three turnaround references that each declare their view.
  const roles = ["turnaround-front", "turnaround-side", "turnaround-back"];
  const views: Record<string, string> = {
    "turnaround-front": "front",
    "turnaround-side": "left",
    "turnaround-back": "back",
  };
  await mkdir(join(dir, "bible3d", "refs"), { recursive: true });
  for (const [i, role] of roles.entries())
    await writeFile(join(dir, "bible3d", "refs", `${role}.png`), encodePng(drawSubject(64, i * 4)));
  const bible3d = join(dir, "bible3d", "bible.json");
  await writeFile(
    bible3d,
    JSON.stringify({
      format: "assetgrove-style-bible/1",
      referenceLicense: "NOASSERTION",
      version: "2026-11-10",
      palette: PALETTE,
      references: roles.map((role) => ({
        path: `refs/${role}.png`,
        role,
        subject: "fern",
        view: views[role],
      })),
      perspective: "refs/turnaround-front.png",
      subjects: { fern: { description: "a lean grey fox" } },
    }),
  );

  const lib = (command: string, ...extra: string[]) =>
    cli(["library", command, "--target", target, "--profile", profilePath, ...extra, "--json"]);

  /** Stages `spec` on `script` and picks candidate c1 into the library. */
  async function stagePick(spec: AssetSpec, script: string, bibleFile: string): Promise<void> {
    const specPath = join(dir, `${spec.assetId}.spec.json`);
    await writeFile(specPath, JSON.stringify(spec));
    const staged = await ok([
      ...["stage", "--spec", specPath, "--bible", bibleFile, "--profile", profilePath],
      ...["--runs", runs, "--candidates", "1", "--provider-script", script],
    ]);
    await ok(["pick", "--run", staged["runDir"], "--candidate", "c1", "--target", target]);
  }

  // Build the library: two stills, a four-frame strip of 32 px frames, a 3D asset.
  await stagePick({ kind: "still", assetId: "lantern", subject: "fern" }, STILL_SCRIPT, bible);
  await stagePick({ kind: "still", assetId: "torch", subject: "fern" }, STILL_SCRIPT, bible);
  const keyPose = join(dir, "key-pose.png");
  await writeFile(keyPose, encodePng(drawSubject(96, 0)));
  await stagePick(
    {
      kind: "sprite-strip",
      assetId: "walker",
      subject: "fern",
      animationFamily: "walk",
      frames: { count: 4 },
      keyPose,
    },
    STILL_SCRIPT,
    bible,
  );
  await stagePick(
    {
      kind: "character-3d",
      assetId: "fern",
      subject: "fern",
      gait: "biped",
      clips: ["idle"],
      heightM: 0.5,
    },
    SCRIPT_3D,
    bible3d,
  );
  // A strip's card is named for its animation family too.
  const cards = ["lantern", "torch", "walker-walk", "fern"].map((id) => join(library, `${id}.md`));
  const reviews = cards.map((c) => c.replace(/\.md$/, ".review.json"));
  assert.equal((await lib("check")).code, 0);

  // A mask file for the torch: white where the change goes (a 96 px still).
  const mask = createRaster(96, 96);
  for (let y = 0; y < 96; y++)
    for (let x = 0; x < 96; x++)
      setPixel(mask, x, y, x < 30 && y < 30 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
  const maskPath = join(target, "mask.png");
  await writeFile(maskPath, encodePng(mask));

  // Request the four changes; each is a run of one candidate whose pick answers it.
  const change = (card: string, script: string, region: string, ...extra: string[]) =>
    ok([
      ...["request-change", card, "--region", region, "--candidates", "1"],
      ...["--runs", runs, "--provider-script", script, ...extra],
    ]);
  const requested = [
    await change(cards[0]!, STILL_SCRIPT, "0,0,30,30 : the glass redder"),
    await change(cards[1]!, STILL_SCRIPT, `mask=${maskPath} : the base darker`),
    await change(cards[2]!, STILL_SCRIPT, "0,0,16,16 frame 3 : raise the paw"),
    await change(cards[3]!, SCRIPT_3D, "0,0,40,40 view 2 : darker ear tips", "--bible", bible3d),
  ];
  assert.deepEqual(
    requested.map((r) => r["job"]),
    ["masked-edit", "masked-edit", "fix-frame", "3d-round"],
  );
  const asked: string[][] = [];
  for (const [i, r] of requested.entries()) {
    const record = parseReview(await readFile(reviews[i]!, "utf8"), reviews[i]!);
    assert.equal(versionStatus(record, record.versions[0]!.sha256), "changes-requested");
    asked.push((r["requests"] as Array<{ id: string }>).map((q) => q.id));
  }

  // Pick each answer, then approve each new version as a person.
  for (const r of requested)
    await ok(["pick", "--run", r["runDir"], "--candidate", "c1", "--target", target]);
  useAttended();
  for (const card of cards) await confirmed(["approve", card]);

  for (const [i, path] of reviews.entries()) {
    const record: ReviewRecord = parseReview(await readFile(path, "utf8"), path);
    assert.equal(record.versions.length, 2, path);
    assert.deepEqual(record.versions[1]!.answers, asked[i], `${path} answers its request`);
    assert.equal(versionStatus(record, record.versions[1]!.sha256), "approved", path);
  }

  const checked = await lib("check");
  assert.equal(checked.code, 0, checked.stdout + checked.stderr);
  assert.deepEqual(doc(checked)["problems"], []);

  // Delete every index.md and log.md, and hand-edit a card's machine field.
  const before = await projections(library);
  const generated = Object.keys(before).filter((n) => /(^|[\\/])(index|log)\.md$/.test(n));
  assert.ok(generated.length >= 2);
  for (const name of generated) await rm(join(library, name));
  const card = cards[0]!;
  await writeFile(card, before["lantern.md"]!.replace(/^state: .*$/m, "state: rejected"));
  assert.equal((await lib("check")).code, 6);

  const rebuilt = await lib("rebuild");
  assert.equal(rebuilt.code, 0, rebuilt.stdout + rebuilt.stderr);
  assert.deepEqual(await projections(library), before);
  assert.equal((await lib("check")).code, 0);
  assert.deepEqual(doc(await lib("rebuild"))["rebuilt"], []);
});
