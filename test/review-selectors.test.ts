/**
 * Review records /2 (#476): anchors on a version (a frame range, an atlas cell, a time range), their
 * structural checks, the bounds check against a version's extent, and a /1 record read forward with
 * every note and resolution it holds.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorMembers, anchorOf, checkAnchor } from "../src/library/extent.ts";
import type { VersionExtent } from "../src/library/extent.ts";
import {
  appendAnnotation,
  appendVersion,
  emptyReview,
  parseReview,
  versionStatus,
  writeReview,
} from "../src/library/review.ts";

const V1 = "a".repeat(64);
const V2 = "b".repeat(64);

function recordWithNotes() {
  let record = emptyReview("asset://grove/walk/review");
  record = appendVersion(record, { sha256: V1, at: "2026-11-20T10:00:00.000Z" });
  record = appendAnnotation(record, {
    type: "Annotation",
    motivation: "editing",
    created: "2026-11-20T11:00:00.000Z",
    body: [{ type: "TextualBody", purpose: "editing", value: "tail tip darker" }],
    target: { source: "walk.png", "ag:version": V1, "ag:frame": 2 },
  });
  const request = record.annotations[0]!.id;
  record = appendAnnotation(record, {
    type: "Annotation",
    motivation: "commenting",
    created: "2026-11-20T12:00:00.000Z",
    body: [{ type: "TextualBody", purpose: "commenting", value: "the hop is late" }],
    target: { source: "walk.png", "ag:version": V1 },
  });
  const comment = record.annotations[1]!.id;
  record = appendAnnotation(record, {
    type: "Annotation",
    motivation: "moderating",
    created: "2026-11-20T13:00:00.000Z",
    target: comment,
    "ag:action": "resolve",
    "ag:resolves": comment,
  });
  record = appendVersion(record, {
    sha256: V2,
    at: "2026-11-21T09:00:00.000Z",
    answers: [request],
    confirmation: { method: "tty", digest: "d".repeat(64) },
  });
  return { record, request, comment };
}

test("a /1 record reads forward with its notes and resolved history, and writes as /2 keeping every line", () => {
  const { record } = recordWithNotes();
  const v2Text = writeReview(record);
  assert.match(v2Text, /"ag:format": "assetgrove-review\/2"/);
  const v1Text = v2Text.replace("assetgrove-review/2", "assetgrove-review/1");
  const read = parseReview(v1Text, "walk.review.json");
  assert.deepEqual(read.versions, record.versions);
  assert.deepEqual(read.annotations, record.annotations);
  assert.equal(versionStatus(read, V1), "pending");
  // Written again, the only changed line is the format line.
  const rewritten = writeReview(read);
  const before = v1Text.split("\n");
  const after = rewritten.split("\n");
  assert.equal(after.length, before.length);
  const changed = after.filter((line, i) => line !== before[i]);
  assert.deepEqual(changed, ['"ag:format": "assetgrove-review/2",']);
});

test("a union merge of a /1 and a /2 branch still reads as the union", () => {
  const { record } = recordWithNotes();
  const text = writeReview(record);
  const lines = text.split("\n");
  const formatAt = lines.findIndex((l) => l.startsWith('"ag:format"'));
  lines.splice(formatAt, 0, '"ag:format": "assetgrove-review/1",');
  const read = parseReview(lines.join("\n"), "merged.review.json");
  assert.equal(read.annotations.length, record.annotations.length);
});

test("a frame range, an atlas cell and a time range are stored against the exact version and read back", () => {
  let record = emptyReview("asset://grove/walk/review");
  record = appendVersion(record, { sha256: V1, at: "2026-11-20T10:00:00.000Z" });
  const anchor = {
    frames: { from: 2, to: 5 },
    cell: { column: 1, row: 0 },
    time: { start: 0.5, end: 1.25 },
  };
  record = appendAnnotation(record, {
    type: "Annotation",
    motivation: "commenting",
    created: "2026-11-20T11:00:00.000Z",
    target: { source: "walk.png", "ag:version": V1, ...anchorMembers(anchor) },
  });
  const read = parseReview(writeReview(record), "walk.review.json");
  const target = read.annotations[0]!.target as Record<string, unknown>;
  assert.equal(target["ag:version"], V1);
  assert.deepEqual(target["ag:frames"], { from: 2, to: 5 });
  assert.deepEqual(target["ag:cell"], { column: 1, row: 0 });
  assert.deepEqual(target["selector"], {
    type: "FragmentSelector",
    conformsTo: "http://www.w3.org/TR/media-frags/",
    value: "t=0.5,1.25",
  });
  assert.deepEqual(anchorOf(target), anchor);
});

test("a malformed anchor is refused naming the selector", () => {
  const base = emptyReview("asset://grove/walk/review");
  const note = (target: Record<string, unknown>) =>
    appendAnnotation(base, {
      type: "Annotation",
      motivation: "commenting",
      created: "2026-11-20T11:00:00.000Z",
      target: { source: "walk.png", "ag:version": V1, ...target },
    });
  assert.throws(
    () => note({ "ag:frames": { from: 5, to: 2 } }),
    /ag:frames needs from at or before to/,
  );
  assert.throws(() => note({ "ag:frames": { from: -1, to: 2 } }), /ag:frames\.from/);
  assert.throws(() => note({ "ag:cell": { column: 1.5, row: 0 } }), /ag:cell\.column/);
  const time = (value: string) =>
    note({
      selector: {
        type: "FragmentSelector",
        conformsTo: "http://www.w3.org/TR/media-frags/",
        value,
      },
    });
  assert.throws(
    () => time("t=3,1"),
    /selector "t=3,1": a time range needs its end after its start/,
  );
  assert.throws(() => time("t=abc"), /selector "t=abc" is not a media-fragment time range/);
  assert.doesNotThrow(() => time("t=npt:1,3"));
});

test("an anchor outside the version names the selector and the valid range", () => {
  const strip: VersionExtent = {
    version: 2,
    image: { width: 128, height: 32 },
    layout: { frames: 4, columns: 4, rows: 1 },
  };
  assert.throws(
    () => checkAnchor({ frames: { from: 2, to: 9 } }, strip, "walk"),
    /^InputError: ag:frames 2-9 is outside version 2 of walk: valid frames are 0-3$/,
  );
  assert.throws(
    () => checkAnchor({ cell: { column: 4, row: 0 } }, strip, "walk"),
    /ag:cell 4,0 is outside version 2 of walk: valid cells are columns 0-3, rows 0-0/,
  );
  assert.doesNotThrow(() =>
    checkAnchor({ frames: { from: 0, to: 3 }, cell: { column: 3, row: 0 } }, strip, "walk"),
  );
  assert.throws(
    () => checkAnchor({ time: { start: 0, end: 1 } }, strip, "walk"),
    /selector t= needs a duration, but version 2 of walk has none/,
  );
  const track: VersionExtent = { version: 1, duration: 2.5 };
  assert.throws(
    () => checkAnchor({ time: { start: 1, end: 3 } }, track, "chime"),
    /selector t=1,3 is outside version 1 of chime: the valid time range is 0-2.5 s/,
  );
  assert.doesNotThrow(() => checkAnchor({ time: { start: 1, end: 2.5 } }, track, "chime"));
  assert.throws(
    () => checkAnchor({ frames: { from: 0, to: 0 } }, track, "chime"),
    /ag:frames needs an image, but version 1 of chime has none/,
  );
});
