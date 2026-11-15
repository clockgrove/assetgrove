/**
 * Every hand-off writes the library beside the media, under the one library write lock (issue
 * #231; docs/library.md): the review record, the card, each index.md and the folder's log.md.
 * These run the real CLI and the real write-families into temporary Git repositories.
 */
import "./fixtures/env.ts";
import { HEADLESS_OPERATOR, approve, approveProfile, useAttended } from "./fixtures/env.ts";
import { stateDir } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { confirmCommand } from "../src/commands/confirm.ts";
import { runCommand } from "../src/commands/runner.ts";
import type { ConfirmPort } from "../src/confirm/prompt.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { encodePng } from "../src/image/raster.ts";
import { loadProfile } from "../src/inputs.ts";
import { parseCard } from "../src/library/card.ts";
import { parseIndex } from "../src/library/folder.ts";
import { appendAnnotation, emptyReview, parseReview, writeReview } from "../src/library/review.ts";
import type { ReviewRecord } from "../src/library/review.ts";
import { DIGITAL_SOURCE_TYPES } from "../src/metadata.ts";
import { defaultRoutes } from "../src/routes.ts";
import { acquireLibraryLock } from "../src/runs/lock.ts";
import { loadSettings } from "../src/settings.ts";
import { importSheet, writeFamilies } from "../src/sheet/import.ts";
import type { Grouping } from "../src/sheet/types.ts";
import type { AssetSpec, TargetProfile } from "../src/types.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import { PALETTE, drawSubject, shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";
import type { World } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
const script3d = fileURLToPath(new URL("./fixtures/model3d-script.ts", import.meta.url));
const validator3d = fileURLToPath(new URL("./fixtures/validator-3d.ts", import.meta.url));
approve(passingScript, script3d);

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env["AI_GATEWAY_API_KEY"];
    delete env["TRIPO_API_KEY"];
    delete env["MESHY_API_KEY"];
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env },
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

/** Every file and directory under `dir`, relative to it with `/`, outside `.git`. */
async function tree(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true }))
    .map((entry) => entry.toString().replaceAll("\\", "/"))
    .filter((entry) => entry !== ".git" && !entry.startsWith(".git/"))
    .sort();
}

const text = (path: string) => readFile(path, "utf8");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The world's target as a Git repository. */
function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
}

/** A world whose target is a Git repository. */
async function gitWorld(): Promise<World> {
  const world = await syntheticWorld();
  gitInit(world.targetDir);
  return world;
}

/** Writes the world's inputs and stages one candidate through the CLI. */
async function stage(world: World, spec: AssetSpec = shelterSpec) {
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

/** A git world whose profile `change` edits (its validator approved), with one candidate staged. */
async function stagedWorld(change: (profile: TargetProfile) => void = () => {}) {
  const world = await gitWorld();
  change(world.profile);
  approveProfile(world.profile, { targetDir: world.targetDir });
  const staged = await stage(world);
  assert.equal(staged.code, 0, staged.stderr);
  return { world, runDir: doc(staged)["runDir"] as string };
}

/** A profile for a still with no animation family: media `<root>/<assetId>.png`, no validator. */
function stillProfile(folder: string, library?: TargetProfile["library"]): Partial<TargetProfile> {
  return {
    layout: {
      media: `${folder}/{{spec.assetId}}.{{output.extension}}`,
      manifest: "manifests/{{spec.assetId}}.json",
    },
    manifest: {
      assetId: "{{spec.assetId}}",
      review: { status: "pending" },
      contentHash: "{{output.sha256}}",
    },
    ...(library && { library }),
  };
}

const stillSpec = (assetId: string): AssetSpec => ({ kind: "still", assetId, subject: "fern" });

/** A git world with a validator-free still profile, one candidate of `assetId` staged. */
async function stagedStill(
  assetId: string,
  folder: string,
  library?: TargetProfile["library"],
  world?: World,
) {
  const w = world ?? (await gitWorld());
  Object.assign(w.profile, stillProfile(folder, library));
  delete w.profile.validator;
  const staged = await stage(w, stillSpec(assetId));
  assert.equal(staged.code, 0, staged.stdout + staged.stderr);
  return { world: w, runDir: doc(staged)["runDir"] as string };
}

function pick(runDir: string, targetDir: string): Promise<Result> {
  return cli(["pick", "--run", runDir, "--candidate", "c1", "--target", targetDir, "--json"]);
}

async function picked(runDir: string, targetDir: string) {
  const r = await pick(runDir, targetDir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  return doc(r);
}

const LOG_LINE = /^- \d\d:\d\d:\d\dZ (\w+) \[([^\]]*)\]\(([^)]*)\): (.*)$/;

async function logLines(path: string): Promise<string[]> {
  return (await text(path)).split("\n").filter((line) => line.startsWith("- "));
}

async function review(path: string): Promise<ReviewRecord> {
  return parseReview(await text(path), path);
}

interface Expected {
  targetDir: string;
  /** The library root and the card folder, relative to the target. */
  rootRel: string;
  dirRel: string;
  id: string;
  game: string;
}

/** The library files of one picked asset: the pair beside the media, every index, one log line. */
async function assertLibrary(e: Expected, options: { log?: boolean } = {}): Promise<void> {
  const dir = join(e.targetDir, e.dirRel);
  assert.ok(existsSync(join(dir, `${e.id}.md`)), "card");
  assert.ok(existsSync(join(dir, `${e.id}.review.json`)), "review record");
  assert.equal((await review(join(dir, `${e.id}.review.json`))).versions.length, 1);

  const folders = [e.rootRel];
  for (const segment of e.dirRel.slice(e.rootRel.length).split("/").filter(Boolean)) {
    folders.push(`${folders.at(-1)}/${segment}`.replace(/^\//, ""));
  }
  for (const folder of folders) {
    const index = join(e.targetDir, folder, "index.md");
    assert.ok(existsSync(index), `${folder}/index.md`);
    const parsed = parseIndex(await text(index), index);
    if (folder === e.rootRel) {
      assert.equal(parsed.root?.okfVersion, "0.2");
      assert.equal(parsed.root?.game, e.game);
      assert.match(await text(index), /^type: Asset Library$/m);
    } else {
      assert.equal(parsed.root, undefined);
    }
    const next = folders[folders.indexOf(folder) + 1];
    if (next !== undefined) assert.ok(parsed.folders.includes(next.split("/").at(-1)!));
    else
      assert.deepEqual(
        parsed.assets.map((a) => a.id),
        [e.id],
      );
  }

  const logPath = join(dir, "log.md");
  if (options.log === false) {
    assert.equal(existsSync(logPath), false);
    return;
  }
  const lines = await logLines(logPath);
  assert.equal(lines.length, 1, lines.join("\n"));
  const match = LOG_LINE.exec(lines[0]!);
  assert.deepEqual(match?.slice(1), ["pick", e.id, `${e.id}.md`, "version 1"]);
}

test("a sprite-strip pick into a Git repository writes the card, review record, every index and one log line beside the media", async () => {
  const { world, runDir } = await stagedWorld();
  const out = await picked(runDir, world.targetDir);
  assert.equal(out["library"].assetId, "fern-shelter");
  assert.equal(out["library"].version, 1);
  assert.equal(out["library"].appended, true);
  assert.ok(existsSync(out["mediaPath"]));
  await assertLibrary({
    targetDir: world.targetDir,
    rootRel: "assets/source",
    dirRel: "assets/source/fern",
    id: "fern-shelter",
    game: "synthetic-grove",
  });
  // No temporary file is left beside them.
  assert.deepEqual(
    (await tree(world.targetDir)).filter((entry) => entry.endsWith(".tmp")),
    [],
  );
});

test("a still pick (no animation family) writes the library beside the media under the media's own folder", async () => {
  const { world, runDir } = await stagedStill("lantern", "props/lights");
  await picked(runDir, world.targetDir);
  await assertLibrary({
    targetDir: world.targetDir,
    rootRel: "props/lights",
    dirRel: "props/lights",
    id: "lantern",
    game: "synthetic-grove",
  });
});

test("with library.log false a pick writes no log.md anywhere", async () => {
  const { world, runDir } = await stagedWorld((profile) => {
    profile.library = { log: false };
  });
  await picked(runDir, world.targetDir);
  await assertLibrary(
    {
      targetDir: world.targetDir,
      rootRel: "assets/source",
      dirRel: "assets/source/fern",
      id: "fern-shelter",
      game: "synthetic-grove",
    },
    { log: false },
  );
  assert.deepEqual(
    (await tree(world.targetDir)).filter((entry) => entry.endsWith("log.md")),
    [],
  );
});

test("write-families of a sprite-strip family writes the library per family, and carries the family's candidate comment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-library-"));
  const targetDir = join(dir, "target");
  await mkdir(targetDir);
  gitInit(targetDir);
  const world = await syntheticWorld();
  const profile = world.profile;
  delete profile.validator;
  const call = new Caller({
    provider: new ScriptedProvider({
      image: () => ({ images: [], costUsd: 0 }),
      vision: () => ({
        text: JSON.stringify({
          families: [{ name: "idle", frames: [1, 2, 3, 4], reason: "standing still" }],
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
  const comment = "the idle loop pops on frame 3";
  await mkdir(join(importDir, "reviews"));
  await writeFile(
    join(importDir, "reviews", "idle.review.json"),
    writeReview(
      appendAnnotation(emptyReview("asset://synthetic-grove/fern-idle/review"), {
        type: "Annotation",
        motivation: "commenting",
        created: "2026-11-20T08:00:00Z",
        body: { type: "TextualBody", value: comment },
        target: { source: "idle.png" },
      }),
    ),
  );
  const confirmed: Grouping = { ...grouping, status: "confirmed" };
  const written = await writeFamilies({ importDir, grouping: confirmed, targetDir });
  assert.equal(written.families[0]?.result.library?.assetId, "fern-idle");
  await assertLibrary({
    targetDir,
    rootRel: "assets/source",
    dirRel: "assets/source/fern",
    id: "fern-idle",
    game: "synthetic-grove",
  });
  const record = await review(join(targetDir, "assets/source/fern/fern-idle.review.json"));
  const carried = record.annotations.find((a) => a.motivation === "commenting");
  assert.deepEqual(carried?.body, { type: "TextualBody", value: comment });
  assert.equal((carried?.target as { source: string }).source, "idle.png");
});

const profile3d = (): Record<string, unknown> => ({
  format: "assetgrove-target-profile/1",
  name: "synthetic-grove-3d",
  license: "MIT",
  values: { creator: "Synthetic Grove" },
  frames: { width: 32, height: 32 },
  model3d: {
    format: "glb",
    budgets: { triangles: 40000, textureMaxPx: 2048, materials: 4, bones: 80, lods: 1 },
    forward: "+z",
    units: "m",
    turntable: { sizePx: 96 },
  },
  layout: {
    media: "characters/{{spec.assetId}}/{{spec.assetId}}.{{output.extension}}",
    manifest: "characters/{{spec.assetId}}/manifest.json",
  },
  manifest: {
    assetManifestVersion: 1,
    assetId: "{{spec.assetId}}",
    kind: "{{spec.kind}}",
    source: {
      kind: "generated",
      path: "{{output.path}}",
      mediaType: "{{output.mediaType}}",
      tool: "assetgrove",
    },
    license: "{{profile.license}}",
    credit: "{{provenance.outputGrant.attribution?}}",
    semantic: "{{spec.fields.semantic?}}",
    review: { status: "pending" },
    model: {
      extension: "{{output.extension}}",
      triangles: "{{output.triangles}}",
      textureMaxPx: "{{output.textureMaxPx}}",
      materials: "{{output.materials}}",
      bones: "{{output.bones}}",
      lods: "{{output.lods}}",
      clips: "{{output.clips}}",
      bounds: "{{output.bounds}}",
    },
    contentHash: "{{output.sha256}}",
  },
  review: { path: "review.status", pending: "pending" },
  validator: { command: [process.execPath, validator3d, "{{manifest}}"] },
});

test("a 3D hand-off (stage character-3d, then pick) writes the library beside the glb", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-library-3d-"));
  await mkdir(join(dir, "refs"));
  const roles = ["turnaround-front", "turnaround-side", "turnaround-back"];
  for (const [i, role] of roles.entries()) {
    await writeFile(join(dir, "refs", `${role}.png`), encodePng(drawSubject(64, i * 4)));
  }
  const files = {
    spec: join(dir, "spec.json"),
    bible: join(dir, "bible.json"),
    profile: join(dir, "profile.json"),
  };
  await writeFile(
    files.spec,
    JSON.stringify({
      kind: "character-3d",
      assetId: "fern",
      subject: "fern",
      gait: "biped",
      clips: ["idle"],
      heightM: 0.5,
    }),
  );
  await writeFile(
    files.bible,
    JSON.stringify({
      format: "assetgrove-style-bible/1",
      referenceLicense: "NOASSERTION",
      version: "2026-11-10",
      palette: PALETTE,
      references: roles.map((role) => ({ path: `refs/${role}.png`, role, subject: "fern" })),
      perspective: "refs/turnaround-front.png",
      subjects: { fern: { description: "a lean grey fox with a dark mask and a ringed tail" } },
    }),
  );
  await writeFile(files.profile, JSON.stringify(profile3d()));
  const target = join(dir, "target");
  await mkdir(target);
  gitInit(target);
  approveProfile(profile3d() as { validator: { command: string[] } }, { targetDir: target });
  const runs = join(dir, "runs");
  const staged = await cli([
    "stage",
    ...["--spec", files.spec, "--bible", files.bible, "--profile", files.profile],
    ...["--runs", runs, "--provider-script", script3d, "--candidates", "1", "--json"],
  ]);
  assert.equal(staged.code, 0, staged.stdout + staged.stderr);
  const out = await picked(doc(staged)["runDir"], target);
  assert.equal(out["library"].assetId, "fern");
  await assertLibrary({
    targetDir: target,
    rootRel: "characters",
    dirRel: "characters/fern",
    id: "fern",
    game: "synthetic-grove-3d",
  });
});

async function cardOf(path: string) {
  return parseCard(await text(path), path);
}

test("the card's verified entries: an attended pick records human:developer with the confirmation method", async () => {
  const { world, runDir } = await stagedWorld();
  useAttended();
  const args = ["pick", "--run", runDir, "--target", world.targetDir, "--json"];
  const asked = await cli(args);
  assert.equal(asked.code, 8, asked.stderr);
  const chooser: ConfirmPort = {
    method: "tty",
    confirm: async () => true,
    choose: async () => "c1",
  };
  const confirmed = await runCommand(
    confirmCommand,
    { id: doc(asked)["error"].confirmation.id },
    { settings: loadSettings(), log: () => {}, prompt: chooser },
  );
  assert.equal(confirmed.exitCode, 0, confirmed.error?.message);
  const out = await cli(args);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  const method = doc(out)["confirmation"].method as string;
  assert.notEqual(method, "headless");

  const dir = join(world.targetDir, "assets/source/fern");
  const verified = (await cardOf(join(dir, "fern-shelter.md"))).data["verified"] as Array<
    Record<string, unknown>
  >;
  const human = verified.filter((v) => String(v["by"]).startsWith("human:"));
  assert.equal(human.length, 1);
  assert.equal(human[0]?.["by"], "human:developer");
  assert.equal(human[0]?.["method"], method);
  assert.equal(
    verified.some((v) => String(v["by"]).startsWith("process:headless")),
    false,
  );
  const version = (await review(join(dir, "fern-shelter.review.json"))).versions[0];
  assert.equal(version?.confirmation?.method, method);
});

test("the card's verified entries: a headless pick records process:headless:<operator> and no human", async () => {
  const { world, runDir } = await stagedWorld();
  await picked(runDir, world.targetDir);
  const dir = join(world.targetDir, "assets/source/fern");
  const verified = (await cardOf(join(dir, "fern-shelter.md"))).data["verified"] as Array<
    Record<string, unknown>
  >;
  const by = verified.map((v) => String(v["by"]));
  assert.ok(by.includes(`process:headless:${HEADLESS_OPERATOR}`), by.join(", "));
  assert.equal(
    by.some((entry) => entry.startsWith("human:")),
    false,
  );
  const version = (await review(join(dir, "fern-shelter.review.json"))).versions[0];
  assert.equal(version?.confirmation?.method, "headless");
  assert.equal(version?.confirmation?.operator, HEADLESS_OPERATOR);
});

test("a candidate's comments are carried into the asset's review record, retargeted at the media", async () => {
  const { world, runDir } = await stagedWorld();
  const body = "the cloak edge is too bright";
  await mkdir(join(runDir, "reviews"));
  await writeFile(
    join(runDir, "reviews", "c1.review.json"),
    writeReview(
      appendAnnotation(emptyReview("asset://synthetic-grove/c1/review"), {
        type: "Annotation",
        motivation: "commenting",
        created: "2026-11-20T08:00:00Z",
        body: { type: "TextualBody", value: body },
        target: { source: "c1.png" },
      }),
    ),
  );
  await picked(runDir, world.targetDir);
  const record = await review(join(world.targetDir, "assets/source/fern/fern-shelter.review.json"));
  const comments = record.annotations.filter((a) => a.motivation === "commenting");
  assert.equal(comments.length, 1);
  assert.deepEqual(comments[0]?.body, { type: "TextualBody", value: body });
  assert.deepEqual(comments[0]?.target, {
    source: "shelter.png",
    "ag:version": record.versions[0]?.sha256,
  });
});

test("a second pick of the same asset with different bytes replaces the media, adds version 2 and keeps what a person wrote", async () => {
  const { world, runDir } = await stagedWorld();
  await picked(runDir, world.targetDir);
  const dir = join(world.targetDir, "assets/source/fern");
  const cardPath = join(dir, "fern-shelter.md");
  const firstMedia = await readFile(join(dir, "shelter.png"));

  const written = (await text(cardPath))
    .replace(/^title: .*$/m, "title: Shelter strip\ndescription: Hand description\nx-custom: kept")
    .concat("\nA hand-written note.\n");
  await writeFile(cardPath, written);

  // A different request, so the provider makes different media for the same asset id.
  const second = await stage(world, { ...shelterSpec, frames: { count: 4 } });
  assert.equal(second.code, 0, second.stdout + second.stderr);
  const out = await picked(doc(second)["runDir"], world.targetDir);
  assert.equal(out["library"].version, 2);

  const media = await readFile(join(dir, "shelter.png"));
  assert.notEqual(sha256(media), sha256(firstMedia));
  assert.equal(await text(join(dir, "log.md")).then((t) => t.includes(" replace ")), true);
  const record = await review(join(dir, "fern-shelter.review.json"));
  assert.deepEqual(
    record.versions.map((v) => v.sha256),
    [sha256(firstMedia), sha256(media)],
  );
  assert.deepEqual(
    record.annotations.filter((a) => a["ag:action"]).map((a) => a["ag:action"]),
    ["pick", "replace"],
  );

  const card = await cardOf(cardPath);
  assert.equal(card.data["version"], 2);
  assert.equal((card.data["lock"] as { sha256: string }).sha256, sha256(media));
  assert.equal(card.data["title"], "Shelter strip");
  assert.equal(card.data["description"], "Hand description");
  assert.equal(card.data["x-custom"], "kept");
  assert.match(card.body, /A hand-written note\./);

  const lines = await logLines(join(dir, "log.md"));
  assert.deepEqual(lines.map((line) => LOG_LINE.exec(line)?.[1]).sort(), ["pick", "replace"]);
});

test("a pick interrupted after the media write is completed by repeating it: one version, card, indexes and log", async () => {
  const { world, runDir } = await stagedWorld();
  await picked(runDir, world.targetDir);
  const dir = join(world.targetDir, "assets/source/fern");
  // The state of a process that died with only the media, provenance and manifest written.
  for (const path of [
    join(dir, "fern-shelter.md"),
    join(dir, "fern-shelter.review.json"),
    join(dir, "log.md"),
    join(dir, "index.md"),
    join(world.targetDir, "assets/source/index.md"),
  ]) {
    await rm(path);
  }
  await picked(runDir, world.targetDir);
  await assertLibrary({
    targetDir: world.targetDir,
    rootRel: "assets/source",
    dirRel: "assets/source/fern",
    id: "fern-shelter",
    game: "synthetic-grove",
  });
  const record = await review(join(dir, "fern-shelter.review.json"));
  assert.equal(record.annotations.filter((a) => a["ag:action"] === "pick").length, 1);
});

test("a pick interrupted after the review record is completed by repeating it, without a second version or log line", async () => {
  const { world, runDir } = await stagedWorld();
  await picked(runDir, world.targetDir);
  const dir = join(world.targetDir, "assets/source/fern");
  const files = ["fern-shelter.md", "log.md", "index.md"].map((name) => join(dir, name));
  files.push(join(world.targetDir, "assets/source/index.md"));
  const before = new Map<string, string>();
  for (const path of [...files, join(dir, "fern-shelter.review.json")]) {
    before.set(path, await text(path));
  }
  for (const path of files) await rm(path);

  const out = await picked(runDir, world.targetDir);
  assert.equal(out["library"].appended, false);
  for (const [path, content] of before) assert.equal(await text(path), content, path);
  const record = await review(join(dir, "fern-shelter.review.json"));
  assert.equal(record.versions.length, 1);
  assert.equal(record.annotations.filter((a) => a["ag:action"] === "pick").length, 1);
  assert.equal((await logLines(join(dir, "log.md"))).length, 1);
});

test("a library lock left by a dead process is taken over and the pick succeeds", async () => {
  const { world, runDir } = await stagedWorld();
  const lockDir = join(world.targetDir, ".git", "assetgrove");
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, "library.lock"), "2147483646\n{}\n");
  const out = await picked(runDir, world.targetDir);
  assert.equal(out["library"].version, 1);
  assert.ok(existsSync(join(world.targetDir, "assets/source/fern/fern-shelter.md")));
});

test("a second writer is refused while another process holds the library lock: exit 2 run_in_progress, nothing written", async () => {
  const { world, runDir } = await stagedWorld();
  const lock = acquireLibraryLock(world.targetDir, stateDir);
  try {
    const r = await pick(runDir, world.targetDir);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.equal(doc(r)["error"].code, "run_in_progress");
    assert.deepEqual(await tree(world.targetDir), []);
  } finally {
    lock.release();
  }
  const after = await pick(runDir, world.targetDir);
  assert.equal(after.code, 0, after.stdout + after.stderr);
});

test("a reserved asset id exits 2 asset_id_reserved with nothing written; stage still accepts the spec", async () => {
  for (const assetId of ["index", "By-Tag"]) {
    const { world, runDir } = await stagedStill(assetId, "props");
    const r = await pick(runDir, world.targetDir);
    assert.equal(r.code, 2, `${assetId}: ${r.stdout}${r.stderr}`);
    assert.equal(doc(r)["error"].code, "asset_id_reserved");
    assert.deepEqual(await tree(world.targetDir), [], assetId);
  }
});

test("an asset id already carded at another folder exits 2 asset_conflict with nothing written", async () => {
  const library = { root: "props" };
  const first = await stagedStill("lantern", "props/a", library);
  await picked(first.runDir, first.world.targetDir);
  const before = await tree(first.world.targetDir);
  const contents = await Promise.all(
    before
      .filter((entry) => /\.(md|json|png)$/.test(entry))
      .map((e) => text(join(first.world.targetDir, e))),
  );

  const second = await stagedStill("lantern", "props/b", library, first.world);
  const r = await pick(second.runDir, first.world.targetDir);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.equal(doc(r)["error"].code, "asset_conflict");
  assert.deepEqual(await tree(first.world.targetDir), before);
  assert.deepEqual(
    await Promise.all(
      before
        .filter((entry) => /\.(md|json|png)$/.test(entry))
        .map((e) => text(join(first.world.targetDir, e))),
    ),
    contents,
  );
});

test("a /1 profile migrates to /2, a /2 profile accepts a library block, and both stage and pick", async () => {
  const world = await gitWorld();
  const file = join(world.dir, "legacy.json");
  await writeFile(file, JSON.stringify(world.profile));
  assert.equal(world.profile.format, "assetgrove-target-profile/1");
  const migrated = await cli(["migrate", file, "--kind", "target-profile", "--json"]);
  assert.equal(migrated.code, 0, migrated.stderr);
  assert.equal(doc(migrated)["format"], "assetgrove-target-profile/2");
  const upgraded = JSON.parse(await text(file));
  assert.equal(upgraded.format, "assetgrove-target-profile/2");
  assert.equal(upgraded.name, world.profile.name);

  // The /1 profile as it was still stages and picks.
  const legacy = await stagedWorld();
  const out = await picked(legacy.runDir, legacy.world.targetDir);
  assert.equal(out["library"].assetId, "fern-shelter");

  // The /2 profile with a library block is accepted and its block used.
  world.profile = { ...upgraded, library: { root: "assets", game: "custom-game", log: true } };
  await writeFile(file, JSON.stringify(world.profile));
  assert.deepEqual((await loadProfile(file)).value.library, {
    root: "assets",
    game: "custom-game",
    log: true,
  });
  approveProfile(world.profile, { targetDir: world.targetDir });
  const staged = await stage(world);
  assert.equal(staged.code, 0, staged.stdout + staged.stderr);
  await picked(doc(staged)["runDir"], world.targetDir);
  await assertLibrary({
    targetDir: world.targetDir,
    rootRel: "assets",
    dirRel: "assets/source/fern",
    id: "fern-shelter",
    game: "custom-game",
  });
});
