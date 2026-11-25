/**
 * `review --placeholder` marks one exact version as a placeholder (issue #479): one `tagging`
 * annotation with the tag body, against that version only, so a release delivery can refuse it.
 */
import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { reviewCommand } from "../src/commands/review.ts";
import { parseCommandLine, runCommand } from "../src/commands/runner.ts";
import { parseReview, placeholderMarks } from "../src/library/review.ts";
import { loadSettings } from "../src/settings.ts";
import { fixtureLibrary } from "./fixtures/library.ts";

const libs: string[] = [];
after(() => Promise.all(libs.map((d) => rm(d, { recursive: true, force: true }))));

async function reviewAt(address: string, ...argv: string[]) {
  const { args } = parseCommandLine(reviewCommand, [address, ...argv]);
  return runCommand(reviewCommand, args, { settings: loadSettings(), log: () => {} });
}

const review = (root: string, ...argv: string[]) => reviewAt(join(root, "lantern.md"), ...argv);

const read = (root: string) => readFileSync(join(root, "lantern.review.json"), "utf8");

test("--placeholder marks exactly the named version and leaves earlier lines unchanged", async () => {
  const lib = fixtureLibrary();
  libs.push(lib.dir);
  const [v1, v2] = lib.versions["lantern"]!;
  assert.ok(v1 && v2, "the fixture's lantern has two versions");
  const before = read(lib.root);
  const beforeCount = parseReview(before, "lantern").annotations.length;

  const done = await review(lib.root, "--version", "1", "--placeholder", "--comment", "temp art");
  assert.equal(done.exitCode, 0, done.error?.message);
  assert.equal(done.fields["placeholder"], true);
  assert.match(done.human, /version 1 is marked as a placeholder/);

  const after = read(lib.root);
  const was = parseReview(before, "lantern").annotations;
  const record = parseReview(after, "lantern");
  assert.deepEqual(record.annotations.slice(0, was.length), was);
  for (const line of before.split("\n").filter((l) => l.includes('"type":"Annotation"'))) {
    assert.ok(after.includes(line.replace(/,$/, "")), "an existing line is kept byte for byte");
  }
  assert.equal(record.annotations.length, beforeCount + 1);
  const added = record.annotations.at(-1)!;
  assert.equal(added.motivation, "tagging");
  assert.equal(added["ag:action"], undefined);
  assert.deepEqual(added.body, [
    { type: "TextualBody", purpose: "tagging", value: "placeholder" },
    { type: "TextualBody", purpose: "commenting", value: "temp art" },
  ]);
  assert.equal((added.target as Record<string, unknown>)["ag:version"], v1);
  assert.deepEqual(
    placeholderMarks(record, v1).map((a) => a.id),
    [added.id],
  );
  assert.deepEqual(placeholderMarks(record, v2), []);
});

test("--placeholder with --reject, --reply, --resolve, --candidate or an anchor is refused and writes nothing", async () => {
  const lib = fixtureLibrary();
  libs.push(lib.dir);
  const before = read(lib.root);
  const versionCases: [string[], RegExp][] = [
    [["--reject", "bad"], /--placeholder marks a version; it does not go with/],
    [["--reply", "#1", "--comment", "x"], /--placeholder marks a version; it does not go with/],
    [["--resolve", "#1"], /--placeholder marks a version; it does not go with/],
    [["--frames", "0-1"], /--placeholder marks the whole version; it takes no --frames/],
  ];
  for (const [extra, message] of versionCases) {
    const done = await review(lib.root, "--placeholder", ...extra);
    assert.equal(done.exitCode, 2, extra.join(" "));
    assert.match(done.error?.message ?? "", message, extra.join(" "));
    assert.equal(read(lib.root), before, extra.join(" "));
  }

  // A real run directory with a QA-passing candidate c1: without --placeholder the same
  // address and candidate are reviewed, so the refusal below is --placeholder's own.
  const runDir = mkdtempSync(join(tmpdir(), "placeholder-run-"));
  libs.push(runDir);
  mkdirSync(join(runDir, "candidates"));
  writeFileSync(join(runDir, "candidates", "c1.png"), "c1");
  writeFileSync(
    join(runDir, "run.json"),
    JSON.stringify({
      runId: "r1",
      candidates: [{ id: "c1", file: "candidates/c1.png", sha256: "a".repeat(64) }],
    }),
  );
  const recordPath = join(runDir, "reviews", "c1.review.json");
  const refused = await reviewAt(runDir, "--candidate", "c1", "--placeholder");
  assert.equal(refused.exitCode, 2);
  assert.match(
    refused.error?.message ?? "",
    /--placeholder marks a version; it does not go with --candidate/,
  );
  assert.equal(existsSync(recordPath), false, "nothing is written for the candidate");
  const commented = await reviewAt(runDir, "--candidate", "c1", "--comment", "x");
  assert.equal(commented.exitCode, 0, commented.error?.message);
  assert.equal(existsSync(recordPath), true);
});
