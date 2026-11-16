/**
 * Writes order after the record's latest stamp, a pick re-checks under the lock, one lock guards a
 * library outside Git, and candidate annotations queue (issue #348).
 */
import { stateDir, useAttended } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { approveCommand } from "../src/commands/review.ts";
import { runCommand } from "../src/commands/runner.ts";
import type { ConfirmPort } from "../src/confirm/prompt.ts";
import { commitTargetWrite, prepareTargetWrite, writeToTarget } from "../src/handoff.ts";
import type { TargetWrite } from "../src/handoff.ts";
import { createRaster, encodePng } from "../src/image/raster.ts";
import { adoptHandEdit, originalFile, workingFile } from "../src/library/adopt.ts";
import { parseCard } from "../src/library/card.ts";
import {
  annotateCandidate,
  loadAsset,
  locateAsset,
  locateCandidate,
  withLibraryLock,
} from "../src/library/actions.ts";
import { libraryDrift, readLibrary, rebuildLibrary } from "../src/library/maintain.ts";
import {
  appendAnnotation,
  appendVersion,
  currentVersion,
  emptyReview,
  nextStamp,
  parseReview,
  versionStatus,
  writeReview,
} from "../src/library/review.ts";
import type { ReviewRecord } from "../src/library/review.ts";
import { libraryConfig } from "../src/library/write.ts";
import { DIGITAL_SOURCE_TYPES } from "../src/metadata.ts";
import { acquireLibraryLock } from "../src/runs/lock.ts";
import { loadSettings } from "../src/settings.ts";
import type { Provenance } from "../src/types.ts";
import { shelterSpec, syntheticProfile } from "./fixtures/synthetic.ts";

const provenance: Provenance = {
  digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
  generator: "sprite-strip",
  route: "scripted",
  models: ["model-a"],
  prompt: "a fern",
  parameters: {},
  requestIds: [],
  referenceHashes: [],
  bibleVersion: "synthetic-1",
  license: "MIT",
  providerTerms: [],
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:01.000Z",
  costUsd: 0,
  calls: [],
};

const FIELDS = {
  frames: { width: 16, height: 8, count: 4, durationMs: 120 },
  anchor: { x: 8, y: 8 },
  bounds: { x: 0, y: 0, width: 16, height: 8 },
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A 64x8 strip whose first pixel is `red`: each value is a different version's bytes. */
function strip(red: number): Uint8Array {
  const raster = createRaster(64, 8);
  raster.data[0] = red;
  raster.data[3] = 255;
  return encodePng(raster);
}

interface Library {
  targetDir: string;
  profile: ReturnType<typeof syntheticProfile>;
  media: string;
  card: string;
  reviewPath: string;
  root: string;
  /** A hand-off of the strip `red`, as a pick of run r1's candidate c1. */
  write(red: number, extra?: Partial<TargetWrite>): TargetWrite;
}

/** A library in a directory with no Git above it, holding the strip `red` as version 1. */
async function library(red = 10): Promise<Library> {
  const targetDir = await mkdtemp(join(realpathSync(tmpdir()), "assetgrove-clock-"));
  const profile = syntheticProfile({ handoff: [{ preset: "manifest" }] as never });
  delete profile.validator;
  const write = (value: number, extra: Partial<TargetWrite> = {}): TargetWrite => ({
    profile,
    spec: shelterSpec,
    bibleVersion: "v1",
    output: { bytes: strip(value), mediaType: "image/png", extension: "png", fields: FIELDS },
    provenance,
    run: { runId: "r1", candidateId: "c1", pickedAt: "2026-01-01T00:00:02.000Z" },
    targetDir,
    ...extra,
  });
  await writeToTarget(write(red));
  // The run that made the asset, as adopt renders from it.
  const runDir = join(targetDir, ".assetgrove/runs/r1");
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "run.json"),
    JSON.stringify({
      runId: "r1",
      profile,
      spec: shelterSpec,
      bibleVersion: "v1",
      candidates: [
        { id: "c1", fields: FIELDS, provenance, mediaType: "image/png", extension: "png" },
      ],
    }),
  );
  return {
    targetDir,
    profile,
    media: join(targetDir, "assets/source/fern/shelter.png"),
    card: join(targetDir, "assets/source/fern/fern-shelter.md"),
    reviewPath: join(targetDir, "assets/source/fern/fern-shelter.review.json"),
    root: libraryConfig(profile, targetDir).root,
    write,
  };
}

const readRecord = async (lib: Library): Promise<ReviewRecord> =>
  parseReview(await readFile(lib.reviewPath, "utf8"), lib.reviewPath);

/** Rewrites every stamp of the record to 2099, in the order they had. */
async function stampInFuture(lib: Library, extra: (record: ReviewRecord) => ReviewRecord) {
  const record = await readRecord(lib);
  let next = emptyReview(record.id);
  record.annotations.forEach((annotation, index) => {
    const content: Record<string, unknown> = { ...annotation };
    delete content["id"];
    next = appendAnnotation(next, {
      ...content,
      created: `2099-01-01T00:00:0${index}.000Z`,
    } as never);
  });
  record.versions.forEach((version, index) => {
    next = appendVersion(next, { ...version, at: `2099-01-01T00:00:0${index}.000Z` });
  });
  await writeFile(lib.reviewPath, writeReview(extra(next)));
}

/** The card's lock matches the file on disk and the library reports nothing modified or wrong. */
async function assertConsistent(lib: Library, expectedSha: string): Promise<void> {
  const record = await readRecord(lib);
  assert.equal(currentVersion(record)?.sha256, expectedSha);
  const data = parseCard(await readFile(lib.card, "utf8"), lib.card).data;
  const lock = (data["lock"] as { sha256: string }).sha256;
  assert.equal(lock, expectedSha);
  assert.equal(lock, sha256(new Uint8Array(await readFile(lib.media))));
  const state = await readLibrary(lib.profile, lib.targetDir);
  assert.deepEqual(state.problems, []);
  assert.deepEqual((await libraryDrift(state, undefined)).modified, []);
}

test("a pick and an adopt into a record stamped in 2099 are current, locked and unmodified; adopting the same bytes again is version_exists", async () => {
  const lib = await library(10);
  await stampInFuture(lib, (record) => record);
  const future = (await readRecord(lib)).versions[0]!.at;
  assert.ok(future.startsWith("2099"));

  const picked = await writeToTarget(
    lib.write(60, { replaces: (await readRecord(lib)).versions[0]!.sha256 }),
  );
  const afterPick = await readRecord(lib);
  assert.equal(afterPick.versions.length, 2);
  assert.ok(afterPick.versions[1]!.at > future, afterPick.versions[1]!.at);
  assert.equal(picked.library?.version, 2);
  await assertConsistent(lib, sha256(new Uint8Array(await readFile(lib.media))));

  const original = join(lib.targetDir, "original.png");
  await copyFile(lib.media, original);
  await writeFile(lib.media, strip(200));
  const options = async () => {
    const asset = await loadAsset(locateAsset(lib.card));
    return {
      asset,
      targetDir: lib.targetDir,
      edited: await workingFile(asset),
      original: await originalFile(asset, original),
      gate: { settings: loadSettings() },
    };
  };
  const adopted = await adoptHandEdit(await options());
  assert.equal(adopted.version, 3);
  const afterAdopt = await readRecord(lib);
  assert.ok(afterAdopt.versions[2]!.at > afterPick.versions[1]!.at);
  await assertConsistent(lib, adopted.sha256);

  await assert.rejects(
    async () => workingFile(await loadAsset(locateAsset(lib.card))),
    (error: Error & { code?: string }) => error.code === "version_exists",
  );
});

test("an approve after a reject stamped in 2099 leaves the version approved", async (t) => {
  t.after(() => useAttended());
  useAttended();
  const lib = await library(10);
  const sha = (await readRecord(lib)).versions[0]!.sha256;
  await stampInFuture(lib, (record) =>
    appendAnnotation(record, {
      type: "Annotation",
      motivation: "assessing",
      created: "2099-06-01T00:00:00.000Z",
      target: { source: "shelter.png", "ag:version": sha },
      "ag:action": "reject",
    } as never),
  );
  assert.equal(versionStatus(await readRecord(lib), sha), "rejected");
  const port: ConfirmPort = {
    method: "tty",
    confirm: async () => true,
    choose: async (request) => request.choices?.[0],
  };
  const done = await runCommand(
    approveCommand,
    { address: lib.card },
    { settings: loadSettings(), log: () => {}, prompt: port },
  );
  assert.equal(done.exitCode, 0, done.error?.message);
  const record = await readRecord(lib);
  assert.equal(versionStatus(record, sha), "approved");
  assert.ok(record.annotations.at(-1)!.created > "2099-06-01T00:00:00.000Z");
});

/** Joins two branches' edits of one base as Git's union merge driver does. */
function union(base: string, ours: string, theirs: string): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "assetgrove-union-"));
  try {
    for (const [name, text] of Object.entries({ base, ours, theirs })) {
      writeFileSync(join(dir, name), text);
    }
    return execFileSync(
      "git",
      ["merge-file", "--union", "-p", join(dir, "ours"), join(dir, "base"), join(dir, "theirs")],
      { encoding: "utf8" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("records diverged on two branches and joined by union read as one version order, and the library checks after rebuild", async () => {
  const lib = await library(10);
  const base = await readFile(lib.reviewPath, "utf8");
  const baseRecord = parseReview(base, "base");
  const picked = await writeToTarget(lib.write(60, { replaces: baseRecord.versions[0]!.sha256 }));
  const real = (await readRecord(lib)).versions[1]!;
  assert.equal(real.sha256, picked.library?.sha256);
  // Two branches each pick (a version and its annotation) at the same instant: only the order
  // rule separates them, and the union interleaves the two sections.
  const ours = await readFile(lib.reviewPath, "utf8");
  const other64 = "0".repeat(64);
  const theirs = writeReview(
    appendAnnotation(appendVersion(baseRecord, { ...real, sha256: other64 }), {
      type: "Annotation",
      motivation: "moderating",
      created: real.at,
      target: { source: "shelter.png", "ag:version": other64 },
      "ag:action": "replace",
    }),
  );

  const forward = union(base, ours, theirs);
  const backward = union(base, theirs, ours);
  assert.notEqual(forward, backward);
  const one = parseReview(forward, "forward");
  const other = parseReview(backward, "backward");
  assert.equal(one.versions.length, 3);
  assert.equal(one.annotations.length, baseRecord.annotations.length + 2);
  assert.deepEqual(one, other);
  assert.equal(writeReview(one), writeReview(other));
  assert.equal(currentVersion(one)?.sha256, real.sha256);

  for (const text of [forward, backward]) {
    await writeFile(lib.reviewPath, text);
    await rebuildLibrary(await readLibrary(lib.profile, lib.targetDir));
    const state = await readLibrary(lib.profile, lib.targetDir);
    assert.deepEqual(state.problems, []);
    assert.deepEqual(state.needsRebuild, []);
  }
});

test("two picks prepared against the same replaced version: the second commit is version_changed and writes no file", async () => {
  const lib = await library(10);
  const first = (await readRecord(lib)).versions[0]!.sha256;
  const one = await prepareTargetWrite(lib.write(60, { replaces: first }));
  const two = await prepareTargetWrite(lib.write(90, { replaces: first }));
  await commitTargetWrite(one);
  const media = await readFile(lib.media);
  const record = await readFile(lib.reviewPath, "utf8");
  await assert.rejects(
    commitTargetWrite(two),
    (error: Error & { code?: string }) => error.code === "version_changed",
  );
  assert.deepEqual(await readFile(lib.media), media);
  assert.equal(await readFile(lib.reviewPath, "utf8"), record);
  assert.equal((await readRecord(lib)).versions.length, 2);
});

const lockUrl = pathToFileURL(join(import.meta.dirname, "..", "src", "runs", "lock.ts")).href;
const actionsUrl = pathToFileURL(
  join(import.meta.dirname, "..", "src", "library", "actions.ts"),
).href;

/** Runs `body` (using `m`, the module) in another process; its one printed line. */
function child(url: string, body: string): string {
  const script = `import(${JSON.stringify(url)}).then(async (m) => { try { ${body} } catch (e) { console.log(e.code ?? e.message); } });`;
  return execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }).trim();
}

test("outside Git a hand-off and a review take the same lock: whichever holds it, the other is run_in_progress", async () => {
  const lib = await library(10);
  const location = locateAsset(lib.card);
  const state = stateDir;
  const handoffLock = acquireLibraryLock(libraryConfig(lib.profile, lib.targetDir).root, state);
  const reviewLockPath = await withLibraryLock(location, state, async () => {
    // Held by the review: the hand-off's own lock path is the same file, so it is busy here too.
    assert.throws(
      () => acquireLibraryLock(lib.root, state),
      (error: Error & { code?: string }) => error.code === "run_in_progress",
    );
    return "held";
  }).catch((error: Error & { code?: string }) => error.code);
  // The hand-off held it first, so the review's lock is refused.
  assert.equal(reviewLockPath, "run_in_progress");
  assert.equal(
    child(
      actionsUrl,
      `await m.withLibraryLock(${JSON.stringify(location)}, ${JSON.stringify(state)}, async () => {}); console.log("acquired");`,
    ),
    "run_in_progress",
  );
  handoffLock.release();

  // The review holds it: a hand-off from another process and a real commit are both refused.
  await withLibraryLock(location, state, async () => {
    assert.equal(
      child(
        lockUrl,
        `m.acquireLibraryLock(${JSON.stringify(lib.root)}, ${JSON.stringify(state)}); console.log("acquired");`,
      ),
      "run_in_progress",
    );
    await assert.rejects(
      writeToTarget(lib.write(60)),
      (error: Error & { code?: string }) => error.code === "run_in_progress",
    );
  });
  const free = acquireLibraryLock(lib.root, state);
  free.release();
});

test("two annotations of one candidate started at once both land in its record", async () => {
  const runDir = mkdtempSync(join(realpathSync(tmpdir()), "assetgrove-candidate-"));
  const file = "c1.png";
  const bytes = strip(10);
  writeFileSync(join(runDir, file), bytes);
  writeFileSync(
    join(runDir, "run.json"),
    JSON.stringify({
      runId: "r1",
      candidates: [{ id: "c1", file, sha256: sha256(bytes) }],
    }),
  );
  const location = await locateCandidate(runDir, "c1");
  await mkdir(join(runDir, "reviews"), { recursive: true });
  const annotate = (value: string) =>
    annotateCandidate(location, (record) => ({
      type: "Annotation",
      motivation: "commenting",
      created: nextStamp(record),
      body: [{ type: "TextualBody", purpose: "commenting", value }],
      target: { source: `../${file}`, "ag:version": location.sha256 },
    }));
  await Promise.all([annotate("first"), annotate("second"), annotate("third")]);
  const record = parseReview(await readFile(location.reviewPath, "utf8"), location.reviewPath);
  const values = record.annotations.flatMap((a) =>
    (Array.isArray(a.body) ? a.body : []).map((b) => (b as { value: string }).value),
  );
  assert.deepEqual(values.sort(), ["first", "second", "third"]);
});
