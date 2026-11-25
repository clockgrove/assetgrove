import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { BLOCK, LfsRequiredError } from "../src/gitlfs.ts";
import { writeToTarget } from "../src/handoff.ts";
import type { TargetWrite } from "../src/handoff.ts";
import type { Provenance } from "../src/types.ts";
import { shelterSpec, syntheticProfile } from "./fixtures/synthetic.ts";
import { toneWav } from "./fixtures/wav.ts";
import { InputError } from "../src/errors.ts";
import { MediaMissingError } from "../src/library/lfs.ts";
import { findGitDir, lfsObjectPath, parseLfsPointer, readMedia } from "../src/library/lfs.ts";

const enc = (text: string) => new TextEncoder().encode(text);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pointerText = (oid: string, size: number) =>
  `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;

async function fixture(): Promise<{
  repo: string;
  media: string;
  object: Uint8Array;
  oid: string;
  text: string;
}> {
  const repo = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-lfs-")));
  const object = enc("synthetic media bytes");
  const oid = hash(object);
  const text = pointerText(oid, object.length);
  await mkdir(join(repo, ".git"), { recursive: true });
  await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  await mkdir(join(repo, "lib"), { recursive: true });
  const media = join(repo, "lib", "a.png");
  await writeFile(media, text);
  return { repo, media, object, oid, text };
}

async function store(repo: string, oid: string, bytes: Uint8Array): Promise<void> {
  const path = lfsObjectPath(join(repo, ".git"), oid);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, bytes);
}

test("parseLfsPointer recognises a v1 pointer and rejects near-misses", () => {
  const oid = "a".repeat(64);
  assert.deepEqual(parseLfsPointer(enc(pointerText(oid, 12))), { oid, size: 12 });
  assert.equal(parseLfsPointer(enc(pointerText("a".repeat(63), 12))), undefined);
  assert.equal(parseLfsPointer(enc(pointerText("A".repeat(64), 12))), undefined);
  assert.equal(
    parseLfsPointer(enc(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\n`)),
    undefined,
  );
  assert.equal(parseLfsPointer(enc(pointerText(oid, 12).replace("spec/v1", "spec/v2"))), undefined);
  assert.equal(parseLfsPointer(enc(pointerText(oid, 12).trimEnd())), undefined);
  assert.equal(parseLfsPointer(enc("plain")), undefined);
});

test("lfsObjectPath fans out by the first two byte pairs of the oid", () => {
  const oid = "abcd" + "0".repeat(60);
  assert.equal(lfsObjectPath("/g", oid), join("/g", "lfs", "objects", "ab", "cd", oid));
});

test("a pointer with its object stored locally reads the object, never the pointer text", async () => {
  const { repo, media, object, oid, text } = await fixture();
  await store(repo, oid, object);
  const read = await readMedia(media, { sha256: oid });
  assert.equal(read.kind, "lfs-object");
  assert.ok("bytes" in read);
  assert.deepEqual(Buffer.from(read.bytes), Buffer.from(object));
  assert.notDeepEqual(Buffer.from(read.bytes), Buffer.from(text));
  assert.equal(read.sha256, oid);
  assert.equal(read.matches, true);
  assert.equal((await readMedia(media, { sha256: "b".repeat(64) })).matches, false);
  assert.equal("matches" in (await readMedia(media)), false);
});

test("a pointer whose object is missing stays a pointer without bytes", async () => {
  const { media, oid } = await fixture();
  const read = await readMedia(media, { sha256: oid.toUpperCase() });
  assert.equal(read.kind, "lfs-pointer");
  assert.equal("bytes" in read, false);
  assert.equal(read.matches, true);
  assert.equal(read.sha256, oid);
});

test("a stored object that does not hash to the oid is not trusted", async () => {
  const { repo, media, oid } = await fixture();
  await store(repo, oid, enc("synthetic media bytez"));
  const read = await readMedia(media);
  assert.equal(read.kind, "lfs-pointer");
  assert.equal("bytes" in read, false);
});

test("a plain file reads as a file with its own hash", async () => {
  const { repo } = await fixture();
  const plain = join(repo, "lib", "b.png");
  const bytes = enc("not a pointer");
  await writeFile(plain, bytes);
  const read = await readMedia(plain, { sha256: hash(bytes) });
  assert.equal(read.kind, "file");
  assert.equal(read.sha256, hash(bytes));
  assert.equal(read.matches, true);
});

test("a near-miss pointer is refused by readMedia, never returned as media", async () => {
  const { repo, oid, object, text } = await fixture();
  await store(repo, oid, object);
  const nearMisses = [
    text.trimEnd(),
    `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\n`,
    text.replace(`sha256:${oid}`, `sha256:${oid.slice(1)}`),
  ];
  for (const [i, nearMiss] of nearMisses.entries()) {
    const media = join(repo, "lib", `near-${i}.png`);
    await writeFile(media, nearMiss);
    await assert.rejects(readMedia(media, { sha256: oid }), InputError);
  }
});

test("a missing media file is invalid input", async () => {
  const { repo } = await fixture();
  await assert.rejects(readMedia(join(repo, "lib", "none.png")), InputError);
  await assert.rejects(readMedia(join(repo, "lib", "none.png")), (error: unknown) => {
    assert.ok(error instanceof MediaMissingError);
    assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOENT");
    return true;
  });
  await assert.rejects(readMedia(join(repo, "lib")), MediaMissingError);
});

test("findGitDir follows a gitdir file and a commondir to the shared store", async () => {
  const { repo } = await fixture();
  assert.equal(findGitDir(join(repo, "lib")), join(repo, ".git"));

  const tree = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-wt-")));
  const gitdir = join(repo, ".git", "worktrees", "wt");
  await mkdir(gitdir, { recursive: true });
  await writeFile(join(gitdir, "commondir"), "../..\n");
  await mkdir(join(tree, "deep"), { recursive: true });
  await writeFile(join(tree, ".git"), `gitdir: ${gitdir}\n`);
  assert.equal(findGitDir(join(tree, "deep")), join(repo, ".git"));

  const bare = join(tree, "rel");
  await mkdir(join(bare, "inner"), { recursive: true });
  await mkdir(join(bare, "real-git"), { recursive: true });
  await writeFile(join(bare, ".git"), "gitdir: real-git\n");
  assert.equal(findGitDir(join(bare, "inner")), join(bare, "real-git"));
});

const wavProvenance: Provenance = {
  digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
  generator: "tone",
  route: "scripted",
  models: [],
  prompt: "",
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

async function wavWrite(attributes: string | undefined): Promise<TargetWrite> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-lfs-wav-")));
  execFileSync("git", ["init", "-q", dir]);
  if (attributes !== undefined) {
    await mkdir(join(dir, "assets/source"), { recursive: true });
    await writeFile(join(dir, "assets/source/.gitattributes"), attributes);
  }
  const profile = syntheticProfile();
  delete profile.validator;
  return {
    profile,
    spec: shelterSpec,
    bibleVersion: "v1",
    output: {
      bytes: toneWav(),
      mediaType: "audio/wav",
      extension: "wav",
      fields: {
        frames: { width: 16, height: 8, count: 1, durationMs: 120 },
        anchor: { x: 8, y: 8 },
        bounds: { x: 0, y: 0, width: 16, height: 8 },
      },
    },
    provenance: wavProvenance,
    run: { runId: "r1", candidateId: "c1", pickedAt: "2026-01-01T00:00:02.000Z" },
    targetDir: dir,
    requireLfs: true,
  };
}

test("pick refuses a WAV Git would store outside LFS, and hands it off once the rule exists", async () => {
  const bare = await wavWrite(undefined);
  await assert.rejects(
    writeToTarget(bare),
    (error) =>
      error instanceof LfsRequiredError && error.paths.some((path) => path.endsWith(".wav")),
  );
  const ready = await wavWrite(BLOCK);
  const result = await writeToTarget(ready);
  assert.ok((await readFile(result.mediaPath)).length > 0);
});
