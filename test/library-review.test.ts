import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalJson } from "../src/library/canonical.ts";
import { InputError } from "../src/errors.ts";
import {
  annotationId,
  appendAnnotation,
  appendVersion,
  checkReviewPaths,
  emptyReview,
  parseReview,
  versionNumber,
  versionStatus,
  withId,
  writeReview,
  type AnnotationInput,
  type ReviewRecord,
} from "../src/library/review.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const MASK = `lantern-porch.review/${"d".repeat(64)}.png`;

function edit(
  value: string,
  target: Record<string, unknown>,
  created = "2026-11-22T09:00:00Z",
): AnnotationInput {
  return {
    type: "Annotation",
    motivation: "editing",
    created,
    body: [{ type: "TextualBody", purpose: "editing", value }],
    target: { source: "lantern-porch.png", "ag:version": SHA_A, ...target },
  };
}

function base(): ReviewRecord {
  return appendAnnotation(
    emptyReview("asset://my-game/lantern-porch/review"),
    edit("base", {}, "2026-11-22T08:00:00Z"),
  );
}

test("a record with a box, a mask, a frame, a view and an answered request validates", () => {
  let record = emptyReview("asset://my-game/lantern-porch/review");
  record = appendAnnotation(
    record,
    edit("tail tip darker", {
      selector: {
        type: "FragmentSelector",
        conformsTo: "http://www.w3.org/TR/media-frags/",
        value: "xywh=10,20,30,40",
      },
    }),
  );
  record = appendAnnotation(record, edit("mask", { "ag:mask": MASK }, "2026-11-22T09:01:00Z"));
  record = appendAnnotation(record, edit("frame", { "ag:frame": 3 }, "2026-11-22T09:02:00Z"));
  record = appendAnnotation(record, edit("view", { "ag:view": 1 }, "2026-11-22T09:03:00Z"));
  const request = record.annotations[0]!.id;
  record = appendVersion(record, { sha256: SHA_A, at: "2026-11-22T08:00:00Z" });
  record = appendVersion(record, {
    sha256: SHA_B,
    at: "2026-11-22T10:00:00Z",
    answers: [request],
    confirmation: { method: "tty" },
  });
  const text = writeReview(record);
  assert.doesNotThrow(() => JSON.parse(text));
  assert.deepEqual(parseReview(text, "r.json"), record);
  assert.equal(writeReview(parseReview(text, "r.json")), text);
});

test("an annotation id follows its content, not its key order", () => {
  const one = edit("x", {});
  const reordered = Object.fromEntries(Object.entries(one).reverse()) as AnnotationInput;
  assert.equal(annotationId(one), annotationId(reordered));
  assert.match(annotationId(one), /^#[0-9a-f]{16}$/);
  assert.notEqual(annotationId(one), annotationId(edit("y", {})));
  assert.equal(withId(one).id, annotationId(one));
  assert.deepEqual(Object.keys(withId(one))[0], "id");

  const text = writeReview(appendAnnotation(emptyReview("asset://a/b/review"), one));
  const tampered = text.replace(/"id":"#[0-9a-f]{16}"/, '"id":"#0000000000000000"');
  assert.notEqual(tampered, text);
  assert.throws(() => parseReview(tampered, "r.json"), InputError);
  assert.equal(canonicalJson({ b: 1, a: [2, undefined], c: undefined }), '{"a":[2,null],"b":1}');
});

test("a version's number is its position in the stack", () => {
  let record = emptyReview("asset://a/b/review");
  record = appendVersion(record, { sha256: SHA_C, at: "2026-11-23T00:00:00Z" });
  record = appendVersion(record, { sha256: SHA_A, at: "2026-11-21T00:00:00Z" });
  record = appendVersion(record, { sha256: SHA_B, at: "2026-11-22T00:00:00Z" });
  record = appendVersion(record, { sha256: SHA_B, at: "2026-11-24T00:00:00Z" });
  assert.equal(versionNumber(record, SHA_A), 1);
  assert.equal(versionNumber(record, SHA_B), 2);
  assert.equal(versionNumber(record, SHA_C), 3);
  assert.equal(versionNumber(record, "e".repeat(64)), undefined);
});

/** Joins two branches' edits of one base as Git's union merge driver does: `git merge-file --union`. */
function union(baseText: string, ours: string, theirs: string): string {
  const dir = mkdtempSync(join(tmpdir(), "assetgrove-union-"));
  try {
    const files = { base: baseText, ours, theirs };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return execFileSync(
      "git",
      ["merge-file", "--union", "-p", join(dir, "ours"), join(dir, "base"), join(dir, "theirs")],
      { encoding: "utf8" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("two branches' appends join line by line into the union", () => {
  const start = base();
  const x = edit("ours", {}, "2026-11-22T09:00:00Z");
  const y = edit("theirs", {}, "2026-11-22T09:05:00Z");
  const ours = appendAnnotation(start, x);
  const theirs = appendAnnotation(start, y);
  const merged = union(writeReview(start), writeReview(ours), writeReview(theirs));
  assert.throws(() => JSON.parse(merged));
  const parsed = parseReview(merged, "merged.json");
  const expected = appendAnnotation(appendAnnotation(start, x), y);
  assert.equal(parsed.annotations.length, 3);
  assert.deepEqual(parsed, expected);
  const canonical = writeReview(parsed);
  assert.doesNotThrow(() => JSON.parse(canonical));
  assert.equal(canonical, writeReview(expected));

  const v0 = appendVersion(start, { sha256: SHA_A, at: "2026-11-22T08:00:00Z" });
  const va = appendVersion(v0, { sha256: SHA_B, at: "2026-11-22T09:00:00Z" });
  const vb = appendVersion(v0, { sha256: SHA_C, at: "2026-11-22T09:30:00Z" });
  const mergedVersions = parseReview(
    union(writeReview(v0), writeReview(va), writeReview(vb)),
    "merged.json",
  );
  assert.deepEqual(
    mergedVersions.versions.map((v) => v.sha256),
    [SHA_A, SHA_B, SHA_C],
  );
  assert.equal(
    writeReview(mergedVersions),
    writeReview(appendVersion(appendVersion(v0, va.versions[1]!), vb.versions[1]!)),
  );
});

test("a duplicated line and a missing comma still parse", () => {
  const record = appendAnnotation(base(), edit("second", {}, "2026-11-22T09:00:00Z"));
  const lines = writeReview(record).split("\n");
  const at = lines.findIndex((line) => line.startsWith('{"id"'));
  lines.splice(at, 0, lines[at]!);
  const damaged = lines.map((line) => (line.startsWith('{"id"') ? line.replace(/,$/, "") : line));
  const parsed = parseReview(damaged.join("\n"), "damaged.json");
  assert.deepEqual(parsed, record);
  assert.throws(() => parseReview('{\n"ag:versions": [\nnot json\n]\n}', "bad.json"), /line 3/);
});

test("an answer naming a missing annotation is refused", () => {
  const record = appendVersion(base(), { sha256: SHA_A, at: "2026-11-22T08:00:00Z" });
  assert.throws(
    () =>
      appendVersion(record, {
        sha256: SHA_B,
        at: "2026-11-22T09:00:00Z",
        answers: ["#0123456789abcdef"],
      }),
    InputError,
  );
  const text = writeReview(record).replace(
    `"at":"2026-11-22T08:00:00Z"`,
    `"answers":["#0123456789abcdef"],"at":"2026-11-22T08:00:00Z"`,
  );
  assert.throws(() => parseReview(text, "r.json"), /not an editing annotation/);
});

test("a path that leaves the library root is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-"));
  try {
    const good = appendAnnotation(
      emptyReview("asset://a/b/review"),
      edit("m", { "ag:mask": MASK }),
    );
    checkReviewPaths(good, root, root, "r.json");
    const bad = appendAnnotation(
      emptyReview("asset://a/b/review"),
      edit("m", { "ag:mask": "../../secret.png" }),
    );
    assert.throws(() => checkReviewPaths(bad, root, root, "r.json"), InputError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version status follows decisions, then open change requests", () => {
  let record = appendVersion(base(), { sha256: SHA_A, at: "2026-11-22T08:00:00Z" });
  assert.equal(versionStatus(record, SHA_A), "changes-requested");
  assert.equal(versionStatus(record, SHA_B), "pending");

  const request = record.annotations[0]!.id;
  const resolved = appendAnnotation(record, {
    type: "Annotation",
    motivation: "moderating",
    "ag:action": "resolve",
    "ag:resolves": request,
    created: "2026-11-22T08:30:00Z",
    target: { source: "lantern-porch.png", "ag:version": SHA_A },
  });
  assert.equal(versionStatus(resolved, SHA_A), "pending");

  const answered = appendVersion(record, {
    sha256: SHA_B,
    at: "2026-11-22T09:00:00Z",
    answers: [request],
  });
  assert.equal(versionStatus(answered, SHA_A), "pending");

  const decide = (action: "approve" | "reject", created: string): AnnotationInput => ({
    type: "Annotation",
    motivation: "assessing",
    "ag:action": action,
    created,
    target: { source: "lantern-porch.png", "ag:version": SHA_A },
  });
  record = appendAnnotation(record, decide("approve", "2026-11-22T10:00:00Z"));
  assert.equal(versionStatus(record, SHA_A), "approved");
  record = appendAnnotation(record, decide("reject", "2026-11-22T11:00:00Z"));
  assert.equal(versionStatus(record, SHA_A), "rejected");
  assert.throws(
    () =>
      appendAnnotation(record, {
        type: "Annotation",
        motivation: "assessing",
        created: "2026-11-22T12:00:00Z",
        target: "lantern-porch.png",
      }),
    InputError,
  );
});
