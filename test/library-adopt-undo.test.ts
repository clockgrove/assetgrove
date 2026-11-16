/**
 * A failed `library adopt` leaves every file as it was (docs/library.md, assetgrove#347), shown in
 * a real Git repository: whatever step fails after the first write, `git status` shows only the
 * person's own edit.
 */
import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeToTarget } from "../src/handoff.ts";
import { PRESETS } from "../src/handoff/presets/index.ts";
import type { HandoffPreset } from "../src/handoff/presets/index.ts";
import { createRaster, encodePng } from "../src/image/raster.ts";
import { loadAsset, locateAsset } from "../src/library/actions.ts";
import { adoptHandEdit, originalFile, workingFile } from "../src/library/adopt.ts";
import { parseReview } from "../src/library/review.ts";
import { DIGITAL_SOURCE_TYPES } from "../src/metadata.ts";
import { loadSettings } from "../src/settings.ts";
import type { Provenance } from "../src/types.ts";
import { bareGitTarget } from "./fixtures/git.ts";
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

const fields = {
  frames: { width: 16, height: 8, count: 4, durationMs: 120 },
  anchor: { x: 8, y: 8 },
  bounds: { x: 0, y: 0, width: 16, height: 8 },
};

const MEDIA = "assets/source/fern/shelter.png";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: dir, encoding: "utf8" });

/** What `git status` shows: one porcelain line per changed or new file. */
const status = (dir: string) =>
  git(dir, "status", "--porcelain", "--untracked-files=all")
    .split("\n")
    .filter((line) => line !== "");

/** Whether this process can be refused a read or a write by permissions. */
const permissionsHold = process.platform !== "win32" && process.getuid?.() !== 0;

/** A preset whose read-back always finds a problem, after `sabotage` ran. */
function brokenPreset(sabotage: () => Promise<void> = async () => {}): HandoffPreset {
  return {
    name: "broken",
    optionsSchema: PRESETS.get("manifest")!.optionsSchema,
    write: () => [{ path: "assets/broken.txt", content: "written\n" }],
    check: async () => {
      await sabotage();
      return ["the broken preset always finds a problem"];
    },
  };
}

/** A preset that writes one file at `path`; its read-back runs `check` and returns its problems. */
function writingPreset(
  path: string,
  check: () => Promise<string[]> = async () => [],
): HandoffPreset {
  return {
    name: "broken",
    optionsSchema: PRESETS.get("manifest")!.optionsSchema,
    write: () => [{ path, content: "written\n" }],
    check,
  };
}

/**
 * An asset picked into a Git repository, with every file committed. With `preset`, the run's
 * profile adds it after the manifest and atlas presets, so its file is written after theirs.
 */
async function committedAsset(preset?: HandoffPreset) {
  const targetDir = bareGitTarget(realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-undo-"))));
  const profile = syntheticProfile({
    handoff: [
      { preset: "manifest" },
      { preset: "atlas-json", options: { shape: "array" } },
    ] as never,
  });
  delete profile.validator;
  await writeToTarget({
    profile,
    spec: shelterSpec,
    bibleVersion: "v1",
    output: {
      bytes: encodePng(createRaster(64, 8)),
      mediaType: "image/png",
      extension: "png",
      fields,
    },
    provenance,
    run: { runId: "r1", candidateId: "c1", pickedAt: "2026-01-01T00:00:02.000Z" },
    targetDir,
  });
  const runDir = join(targetDir, ".assetgrove/runs/r1");
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "run.json"),
    JSON.stringify({
      runId: "r1",
      profile: preset
        ? { ...profile, handoff: [...(profile.handoff ?? []), { preset: preset.name }] }
        : profile,
      spec: shelterSpec,
      bibleVersion: "v1",
      candidates: [{ id: "c1", fields, provenance, mediaType: "image/png", extension: "png" }],
    }),
  );
  const media = join(targetDir, MEDIA);
  const original = join(targetDir, "original.png");
  await copyFile(media, original);
  const card = join(targetDir, "assets/source/fern/fern-shelter.md");
  const reviewPath = join(targetDir, "assets/source/fern/fern-shelter.review.json");
  const commit = () => {
    git(targetDir, "add", "-A");
    git(targetDir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "c");
  };
  commit();
  const adopt = async () => {
    const asset = await loadAsset(locateAsset(card));
    return adoptHandEdit({
      asset,
      targetDir,
      edited: await workingFile(asset),
      original: await originalFile(asset, original),
      gate: { settings: loadSettings() },
      ...(preset && { registry: { presets: new Map([...PRESETS, [preset.name, preset]]) } }),
    });
  };
  const versions = async () => parseReview(await readFile(reviewPath, "utf8"), reviewPath).versions;
  return { targetDir, media, adopt, versions, commit };
}

/** The person's hand edit of the working file. */
async function edit(media: string): Promise<Buffer> {
  const raster = createRaster(64, 8);
  raster.data[0] = 200;
  raster.data[3] = 255;
  await writeFile(media, encodePng(raster));
  return readFile(media);
}

test("a hand-off write that fails part-way puts back every file written: git status shows only the person's edit", async () => {
  // A preset writes under a file, after the media and the manifest are written.
  const { targetDir, media, adopt, versions, commit } = await committedAsset(
    writingPreset("assets/blocked/inside.txt"),
  );
  await writeFile(join(targetDir, "assets/blocked"), "a file where a folder goes\n");
  commit();
  const edited = await edit(media);
  await assert.rejects(adopt(), (error: NodeJS.ErrnoException) => error.code !== undefined);
  assert.equal((await versions()).length, 1);
  assert.deepEqual(await readFile(media), edited, "the person's edit is put back");
  assert.deepEqual(status(targetDir), [` M ${MEDIA}`]);
});

test(
  "a manifest folder that cannot be written fails the adopt with EACCES and leaves only the person's edit",
  { skip: !permissionsHold },
  async (t) => {
    const { targetDir, media, adopt, versions } = await committedAsset();
    const folder = join(targetDir, "assets/manifests/fern");
    await chmod(folder, 0o555);
    t.after(() => chmod(folder, 0o755));
    const edited = await edit(media);
    await assert.rejects(adopt(), (error: NodeJS.ErrnoException) => error.code === "EACCES");
    await chmod(folder, 0o755);
    assert.equal((await versions()).length, 1);
    assert.deepEqual(await readFile(media), edited);
    assert.deepEqual(status(targetDir), [` M ${MEDIA}`]);
  },
);

test("a library write that fails after the review record puts back the record, the card and every hand-off file", async () => {
  const log = { path: "" };
  // After every file is read and the hand-off files are written, another program puts a folder
  // where the asset folder's log goes: the library write fails at the log, its last step, after
  // the review record (the commit point), the card and the indexes are written.
  const { targetDir, media, adopt, versions } = await committedAsset(
    writingPreset("assets/broken.txt", async () => {
      await rm(log.path, { force: true });
      await mkdir(log.path);
      return [];
    }),
  );
  log.path = join(targetDir, "assets/source/fern/log.md");
  const edited = await edit(media);
  await assert.rejects(adopt(), (error: NodeJS.ErrnoException) => error.code === "EISDIR");
  assert.equal((await versions()).length, 1, "no version is recorded");
  assert.deepEqual(await readFile(media), edited);
  // The log the other program removed is its own change; every file the adopt wrote is put back.
  assert.deepEqual(status(targetDir), [" D assets/source/fern/log.md", ` M ${MEDIA}`]);
});

test("a library file the adopt cannot read stops it before the first write", async () => {
  const { targetDir, media, adopt, versions, commit } = await committedAsset();
  // The asset folder's log is a folder, which the library write would read last.
  const log = join(targetDir, "assets/source/fern/log.md");
  await rm(log, { force: true });
  await mkdir(log);
  await writeFile(join(log, "keep.txt"), "kept\n");
  commit();
  const edited = await edit(media);
  // A write renames a new file over the media, so an unwritten media keeps its inode.
  const inode = statSync(media).ino;
  await assert.rejects(adopt(), (error: NodeJS.ErrnoException) => error.code === "EISDIR");
  assert.equal((await versions()).length, 1, "no version is recorded");
  assert.deepEqual(await readFile(media), edited, "nothing was written");
  assert.equal(statSync(media).ino, inode, "the media was never written");
  assert.deepEqual(status(targetDir), [` M ${MEDIA}`]);
});

test(
  "a library log with no read permission stops the adopt before the first write and stays",
  { skip: !permissionsHold },
  async (t) => {
    const { targetDir, media, adopt } = await committedAsset();
    const log = join(targetDir, "assets/source/fern/log.md");
    const before = await readFile(log);
    const edited = await edit(media);
    // A write renames a new file over the media, so an unwritten media keeps its inode.
    const inode = statSync(media).ino;
    await chmod(log, 0o000);
    t.after(() => chmod(log, 0o644));
    await assert.rejects(adopt(), (error: NodeJS.ErrnoException) => error.code === "EACCES");
    await chmod(log, 0o644);
    assert.deepEqual(await readFile(log), before, "the log is never removed or changed");
    assert.deepEqual(await readFile(media), edited, "nothing was written");
    assert.equal(statSync(media).ino, inode, "the media was never written");
    assert.deepEqual(status(targetDir), [` M ${MEDIA}`]);
  },
);

test("a file the adopt cannot read stops it before the first write and is never removed", async () => {
  // A folder where the preset's new file goes cannot be read as a file.
  const { targetDir, media, adopt, commit } = await committedAsset(
    writingPreset("assets/broken.txt"),
  );
  await mkdir(join(targetDir, "assets/broken.txt"));
  await writeFile(join(targetDir, "assets/broken.txt/keep.txt"), "kept\n");
  commit();
  const edited = await edit(media);
  await assert.rejects(adopt(), (error: NodeJS.ErrnoException) => error.code === "EISDIR");
  assert.deepEqual(await readFile(media), edited, "nothing was written");
  assert.deepEqual(status(targetDir), [` M ${MEDIA}`]);
});

test(
  "a file with no read permission stops the adopt before the first write and stays",
  { skip: !permissionsHold },
  async (t) => {
    // A file the run's preset writes over, which the person cannot read.
    const { targetDir, media, adopt, commit } = await committedAsset(
      writingPreset("assets/locked.txt"),
    );
    const locked = join(targetDir, "assets/locked.txt");
    await writeFile(locked, "the person's file\n");
    commit();
    await chmod(locked, 0o000);
    t.after(() => chmod(locked, 0o644));
    const edited = await edit(media);
    await assert.rejects(adopt(), (error: NodeJS.ErrnoException) => error.code === "EACCES");
    assert.ok(existsSync(locked), "the file is never removed");
    await chmod(locked, 0o644);
    assert.equal(await readFile(locked, "utf8"), "the person's file\n");
    assert.deepEqual(await readFile(media), edited, "nothing was written");
    assert.deepEqual(status(targetDir), [` M ${MEDIA}`]);
  },
);

/** Moves the media beside itself and links its path to it; false where links cannot be made. */
async function linkMedia(media: string): Promise<string | false> {
  const real = media.replace(/shelter\.png$/, "shelter-real.png");
  await rename(media, real);
  try {
    await symlink("shelter-real.png", media);
    return real;
  } catch {
    await rename(real, media);
    return false;
  }
}

test("media reached through a symbolic link is still a link after a failed adopt, and its target holds the edit", async (t) => {
  const { media, adopt, versions } = await committedAsset(brokenPreset());
  const real = await linkMedia(media);
  if (real === false) return t.skip("this system cannot make a symbolic link");
  const edited = await edit(media);
  await assert.rejects(adopt(), /the broken preset always finds a problem/);
  assert.ok(lstatSync(media).isSymbolicLink(), "the media is still a link");
  assert.deepEqual(await readFile(real), edited);
  assert.equal((await versions()).length, 1);
});

test("after a successful adopt through a symbolic link, the library records the bytes at the path the game reads", async (t) => {
  const { media, adopt, versions } = await committedAsset();
  const real = await linkMedia(media);
  if (real === false) return t.skip("this system cannot make a symbolic link");
  await edit(media);
  const result = await adopt();
  assert.equal(result.version, 2);
  assert.ok(lstatSync(media).isSymbolicLink(), "the media is still a link");
  const current = (await versions()).at(-1)!;
  assert.equal(sha256(await readFile(media)), current.sha256);
});

test("a dangling symbolic link the adopt writes over is a link again after a failed adopt", async (t) => {
  const { targetDir, media, adopt, versions, commit } = await committedAsset(
    writingPreset("assets/dangling.txt", async () => ["the read-back finds a problem"]),
  );
  const link = join(targetDir, "assets/dangling.txt");
  try {
    await symlink("nowhere.txt", link);
  } catch {
    return t.skip("this system cannot make a symbolic link");
  }
  commit();
  const edited = await edit(media);
  await assert.rejects(adopt(), /the read-back finds a problem/);
  assert.ok(lstatSync(link).isSymbolicLink(), "the link is a link again");
  assert.equal(await readlink(link), "nowhere.txt");
  assert.equal((await versions()).length, 1);
  assert.deepEqual(await readFile(media), edited);
  assert.deepEqual(status(targetDir), [` M ${MEDIA}`]);
});

test("a file that cannot be put back does not stop the others; the error is the adopt's, naming that file", async () => {
  const manifestFolder = { path: "" };
  // The read-back fails after it puts a file where the manifest's folder was.
  const preset = brokenPreset(async () => {
    await rm(manifestFolder.path, { recursive: true, force: true });
    await writeFile(manifestFolder.path, "a file where a folder goes\n");
  });
  const { targetDir, media, adopt, versions } = await committedAsset(preset);
  manifestFolder.path = join(targetDir, "assets/manifests/fern");
  const edited = await edit(media);
  await assert.rejects(adopt(), (error: Error & { notRestored?: string[] }) => {
    assert.match(error.message, /the broken preset always finds a problem/);
    assert.match(error.message, /could not be put back/);
    assert.ok(error.notRestored?.some((path) => path.includes("shelter.json")));
    return true;
  });
  assert.equal((await versions()).length, 1);
  assert.deepEqual(await readFile(media), edited, "the media is put back all the same");
  assert.equal(existsSync(join(targetDir, "assets/broken.txt")), false);
});
