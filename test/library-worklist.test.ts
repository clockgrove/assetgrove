/**
 * `library worklist`: review notes with their source version and recorded resolution, read from
 * a review record that is still in the older /1 layout, through the real CLI.
 */
import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  appendAnnotation,
  appendVersion,
  parseReview,
  writeReview,
} from "../src/library/review.ts";
import type { AnnotationInput } from "../src/library/review.ts";
import { fixtureLibrary } from "./fixtures/library.ts";
import type { FixtureLibrary } from "./fixtures/library.ts";

const cwd = fileURLToPath(new URL("..", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

function worklist(lib: FixtureLibrary, ...args: string[]): Promise<Doc> {
  return cli(["library", "worklist", "--target", lib.dir, ...args]);
}

function cli(args: string[]): Promise<Doc> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env["AI_GATEWAY_API_KEY"];
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args, "--json"],
      { cwd, env, timeout: 60_000 },
      (error, stdout, stderr) => {
        try {
          resolve(JSON.parse(stdout) as Doc);
        } catch {
          reject(new Error(String(error) + stdout + stderr));
        }
      },
    );
    child.stdin?.end();
  });
}

test("the work list links each note to its source version and its recorded resolution, and reads a /1 record without changing it", async () => {
  const lib = fixtureLibrary();
  const path = join(lib.root, "walk.review.json");
  const first = lib.versions["walk"]![0]!;
  const second = "b".repeat(64);
  const target = { source: "walk.png", "ag:version": first };
  const note = (created: string, extra: Partial<AnnotationInput>): AnnotationInput =>
    ({
      type: "Annotation",
      created,
      target,
      ...extra,
    }) as AnnotationInput;
  const body = (value: string) => [{ type: "TextualBody" as const, value, purpose: "editing" }];

  let record = parseReview(readFileSync(path, "utf8"), path);
  const edit = note("2099-01-01T09:00:00Z", {
    motivation: "editing",
    target: { ...target, "ag:frames": { from: 1, to: 3 } },
    body: body("lift the paw"),
  });
  record = appendAnnotation(record, edit);
  const editId = record.annotations.find((a) => a.motivation === "editing")!.id;
  record = appendVersion(record, {
    sha256: second,
    at: "2099-01-02T09:00:00Z",
    answers: [editId],
    confirmation: { method: "tty", digest: "c".repeat(64) },
  });
  record = appendAnnotation(
    record,
    note("2099-01-03T09:00:00Z", {
      motivation: "commenting",
      target: {
        ...target,
        selector: {
          type: "FragmentSelector",
          conformsTo: "http://www.w3.org/TR/media-frags/",
          value: "t=0.5,1.25",
        },
      },
      body: body("too slow here"),
    }),
  );
  const comment = record.annotations.find((a) => a.motivation === "commenting")!;
  record = appendAnnotation(
    record,
    note("2099-01-04T09:00:00Z", {
      motivation: "moderating",
      "ag:action": "resolve",
      "ag:resolves": comment.id,
    }),
  );
  record = appendAnnotation(
    record,
    note("2099-01-05T09:00:00Z", { motivation: "commenting", body: body("still open") }),
  );
  const older = writeReview(record).replace('"assetgrove-review/2"', '"assetgrove-review/1"');
  assert.notEqual(older, writeReview(record));
  writeFileSync(path, older);

  const all = await worklist(lib);
  const walk = (doc: Doc) => (doc["notes"] as Doc[]).filter((n) => n["asset"] === "walk");
  assert.deepEqual(
    walk(all).map((n) => [n["motivation"], n["state"]]),
    [
      ["editing", "resolved"],
      ["commenting", "resolved"],
      ["commenting", "open"],
    ],
  );
  const [answered, closed, open] = walk(all) as [Doc, Doc, Doc];
  assert.equal(answered["card"], "walk.md");
  assert.deepEqual(answered["anchor"], { frames: { from: 1, to: 3 } });
  assert.deepEqual(closed["anchor"], { time: { start: 0.5, end: 1.25 } });
  assert.equal(open["anchor"], undefined);
  assert.deepEqual(open["source"], {
    version: 1,
    sha256: first,
    link: "asset://test-grove/walk/versions/1",
  });
  assert.deepEqual(answered["resolution"], {
    by: "answer",
    version: 2,
    sha256: second,
    link: "asset://test-grove/walk/versions/2",
    confirmation: { method: "tty", digest: "c".repeat(64) },
  });
  assert.deepEqual(closed["resolution"], {
    by: "resolve",
    annotation: closed["resolution"].annotation,
    created: "2099-01-04T09:00:00Z",
    link: "asset://test-grove/walk/review",
  });
  assert.match(closed["resolution"].annotation, /^#[0-9a-f]{16}$/);
  // Every link the work list writes is an address the tree reads.
  const links = walk(all).flatMap((n) => [n["source"].link, n["resolution"]?.link]);
  for (const link of links.filter((l): l is string => typeof l === "string")) {
    const read = await cli(["cat", link, "--target", lib.dir]);
    assert.equal(read["error"], undefined, `${link}: ${JSON.stringify(read["error"])}`);
  }
  const reviewDoc = await cli(["cat", "asset://test-grove/walk/review", "--target", lib.dir]);
  assert.ok(JSON.stringify(reviewDoc).includes(closed["resolution"].annotation));
  assert.equal(open["resolution"], undefined);
  assert.equal(all["counts"].open >= 1, true);

  const onlyOpen = await worklist(lib, "--open");
  assert.deepEqual(
    walk(onlyOpen).map((n) => n["id"]),
    [open["id"]],
  );

  assert.equal(readFileSync(path, "utf8"), older);
  const shared = (all["sharedText"] as Doc[]).map((t) => t["text"]).sort();
  assert.deepEqual(shared, ["lift the paw", "still open", "too slow here"]);
  assert.equal(JSON.stringify(all["notes"]).includes("lift the paw"), false);

  // A review action on the older record writes it as /2 and keeps every earlier line.
  const reviewed = await cli(["review", join(lib.root, "walk.md"), "--comment", "one more"]);
  assert.equal(reviewed["annotation"]?.motivation, "commenting", JSON.stringify(reviewed));
  const now = readFileSync(path, "utf8");
  assert.match(now, /"ag:format": "assetgrove-review\/2"/);
  const items = (text: string) =>
    text
      .split("\n")
      .filter((line) => line.startsWith('{"'))
      .map((line) => line.replace(/,$/, ""));
  for (const line of items(older)) assert.ok(items(now).includes(line), line);
  assert.equal(items(now).length, items(older).length + 1);
  const after = await worklist(lib);
  assert.deepEqual(
    walk(after).map((n) => [n["id"], n["state"], n["resolution"]]),
    [
      ...walk(all).map((n) => [n["id"], n["state"], n["resolution"]]),
      [walk(after)[3]!["id"], "open", undefined],
    ],
  );
});
