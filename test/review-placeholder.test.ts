/**
 * `review --placeholder` marks one exact version as a placeholder (issue #479): one `tagging`
 * annotation with the tag body, against that version only, so a release delivery can refuse it.
 */
import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { reviewCommand } from "../src/commands/review.ts";
import { parseCommandLine, runCommand } from "../src/commands/runner.ts";
import { parseReview, placeholderMarks } from "../src/library/review.ts";
import { loadSettings } from "../src/settings.ts";
import { fixtureLibrary } from "./fixtures/library.ts";

const libs: string[] = [];
after(() => Promise.all(libs.map((d) => rm(d, { recursive: true, force: true }))));

async function review(root: string, ...argv: string[]) {
  const { args } = parseCommandLine(reviewCommand, [join(root, "lantern.md"), ...argv]);
  return runCommand(reviewCommand, args, { settings: loadSettings(), log: () => {} });
}

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
  const cases = [
    ["--reject", "bad"],
    ["--reply", "#1", "--comment", "x"],
    ["--resolve", "#1"],
    ["--candidate", "c1"],
    ["--frames", "0-1"],
  ];
  for (const extra of cases) {
    const done = await review(lib.root, "--placeholder", ...extra);
    assert.equal(done.exitCode, 2, extra.join(" "));
    assert.equal(read(lib.root), before, extra.join(" "));
  }
});
