/** A candidate of a request_change run answers its requests when picked (issue #238). */
import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeToTarget } from "../src/handoff.ts";
import { drawSubject } from "./fixtures/synthetic.ts";
import { encodePng } from "../src/image/raster.ts";
import {
  appendAnnotation,
  parseReview,
  versionStatus,
  writeReview,
} from "../src/library/review.ts";
import { AssetIdError } from "../src/library/write.ts";
import type { AssetSpec, Provenance } from "../src/types.ts";
import { DIGITAL_SOURCE_TYPES } from "../src/metadata.ts";
import { libraryProfile } from "./fixtures/library.ts";

const spec: AssetSpec = { kind: "still", assetId: "lamp" };
const provenance: Provenance = {
  digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
  generator: "still",
  route: "scripted",
  models: ["model-a"],
  prompt: "a lamp",
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

function hand(
  targetDir: string,
  seed: number,
  extra: { answers?: { version: string; answers: string[] } } = {},
) {
  return writeToTarget({
    profile: libraryProfile(),
    spec,
    bibleVersion: "synthetic-1",
    output: {
      bytes: encodePng(drawSubject(32, seed)),
      mediaType: "image/png",
      extension: "png",
      fields: {},
    },
    provenance,
    run: { runId: "r1", candidateId: `c${seed}`, pickedAt: "2026-01-01T00:00:02.000Z" },
    targetDir,
    ...extra,
  });
}

test("picking a candidate of a request_change run answers its request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-answers-"));
  const first = await hand(dir, 1);
  const v1 = first.library!.sha256;
  const reviewPath = join(dir, "assets/lamp.review.json");
  let record = parseReview(await readFile(reviewPath, "utf8"), "review");
  record = appendAnnotation(record, {
    type: "Annotation",
    motivation: "editing",
    created: "2026-01-02T00:00:00.000Z",
    body: [{ type: "TextualBody", purpose: "commenting", value: "make it warmer" }],
    target: { source: "lamp.png", "ag:version": v1 },
  });
  const request = record.annotations.find((a) => a.motivation === "editing")!.id!;
  assert.equal(versionStatus(record, v1), "changes-requested");
  await writeFile(reviewPath, writeReview(record));

  const answers = { version: v1, answers: [request, "#0000000000000000"] };
  const second = await hand(dir, 2, { answers });
  assert.equal(second.library!.version, 2);
  const after = parseReview(await readFile(reviewPath, "utf8"), "review");
  assert.deepEqual(after.versions[1]!.answers, [request]);
  assert.notEqual(versionStatus(after, v1), "changes-requested");
  const moderating = after.annotations.find(
    (a) => (a as { "ag:action"?: string })["ag:action"] === "answer",
  )!;
  assert.equal(moderating.body, undefined, "the answer is recorded only in versions[].answers");
  const log = join(dir, "assets/log.md");
  if (existsSync(log)) assert.match(await readFile(log, "utf8"), /answers #[0-9a-f]{16}/);

  // A candidate made on version 1 is stale now that version 2 is current.
  await assert.rejects(
    hand(dir, 3, { answers: { version: v1, answers: [request] } }),
    (error: unknown) =>
      error instanceof AssetIdError &&
      error.code === "version_changed" &&
      error.message.includes(after.versions[1]!.sha256),
  );
  assert.equal(parseReview(await readFile(reviewPath, "utf8"), "review").versions.length, 2);
});
