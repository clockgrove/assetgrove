/**
 * `review` anchors a note to part of a version (issue #476): a frame range, an atlas cell or a time
 * range, stored against the version's sha256 and refused, naming the valid range, when it falls
 * outside what the version's own bytes hold.
 */
import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { reviewCommand } from "../src/commands/review.ts";
import { parseCommandLine, runCommand } from "../src/commands/runner.ts";
import { machineFields, newCard, writeCard } from "../src/library/card.ts";
import {
  appendAnnotation,
  appendVersion,
  emptyReview,
  parseReview,
  writeReview,
} from "../src/library/review.ts";
import { loadSettings } from "../src/settings.ts";
import { GAME, fixtureLibrary, sha256 } from "./fixtures/library.ts";

const libs: string[] = [];
after(() => Promise.all(libs.map((d) => rm(d, { recursive: true, force: true }))));

/** A mono 16-bit PCM WAV of silence, `seconds` long at 8 kHz. */
function wav(seconds: number): Uint8Array {
  const rate = 8000;
  const data = Math.round(seconds * rate) * 2;
  const out = Buffer.alloc(44 + data);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + data, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(data, 40);
  return out;
}

function library() {
  const lib = fixtureLibrary();
  libs.push(lib.dir);
  const provenancePath = join(lib.root, "walk.png.provenance.json");
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as Record<string, unknown>;
  provenance["parameters"] = { frame: { width: 32, height: 32 }, frameCount: 4 };
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

  const bytes = wav(2.5);
  writeFileSync(join(lib.root, "tune.wav"), bytes);
  const sha = sha256(bytes);
  let review = emptyReview(`asset://${GAME}/tune/review`);
  review = appendVersion(review, {
    sha256: sha,
    at: "2026-11-11T10:00:00Z",
    run: "r-0123456789abcdef",
    candidate: "c1",
    confirmation: { method: "headless", operator: "test:fixture" },
  });
  review = appendAnnotation(review, {
    type: "Annotation",
    created: "2026-11-11T10:00:00Z",
    motivation: "moderating",
    "ag:action": "pick",
    target: { source: "tune.wav", "ag:version": sha },
  });
  writeFileSync(join(lib.root, "tune.review.json"), writeReview(review));
  const tuneProvenance = { ...provenance, generator: "audio", parameters: {} };
  writeFileSync(
    join(lib.root, "tune.wav.provenance.json"),
    `${JSON.stringify(tuneProvenance, null, 2)}\n`,
  );
  const fields = machineFields({
    resource: "tune.wav",
    provenance: tuneProvenance as never,
    provenanceResource: "tune.wav.provenance.json",
    review,
    reviewResource: "tune.review.json",
    kind: "audio",
    subject: "tune",
    assetgrove: "0.2.0",
  });
  writeFileSync(join(lib.root, "tune.md"), writeCard(newCard({ title: "Tune", tags: [] }, fields)));
  return { lib, walkSha: lib.versions["walk"]![0]!, tuneSha: sha };
}

async function review(lib: { root: string }, id: string, ...argv: string[]) {
  const address = join(lib.root, `${id}.md`);
  const { args } = parseCommandLine(reviewCommand, [address, ...argv]);
  return runCommand(reviewCommand, args, { settings: loadSettings(), log: () => {} });
}

const recordOf = (lib: { root: string }, id: string) => join(lib.root, `${id}.review.json`);

test("frames, cell and time are stored against the exact version and shown", async () => {
  const { lib, walkSha, tuneSha } = library();

  const frames = await review(lib, "walk", "--comment", "foot slides", "--frames", "1-3");
  assert.equal(frames.exitCode, 0, frames.error?.message);
  assert.deepEqual((frames.fields["annotation"] as Record<string, unknown>)["anchor"], {
    frames: { from: 1, to: 3 },
  });
  assert.match(frames.human, / \(frames 1-3\)/);

  const cell = await review(lib, "walk", "--comment", "wrong tile", "--cell", "2,0");
  assert.equal(cell.exitCode, 0, cell.error?.message);
  assert.deepEqual((cell.fields["annotation"] as Record<string, unknown>)["anchor"], {
    cell: { column: 2, row: 0 },
  });
  assert.match(cell.human, / \(cell 2,0\)/);

  const record = parseReview(readFileSync(recordOf(lib, "walk"), "utf8"), "walk");
  const targets = record.annotations.slice(-2).map((a) => a.target as Record<string, unknown>);
  assert.equal(targets[0]!["ag:version"], walkSha);
  assert.deepEqual(targets[0]!["ag:frames"], { from: 1, to: 3 });
  assert.equal(targets[1]!["ag:version"], walkSha);
  assert.deepEqual(targets[1]!["ag:cell"], { column: 2, row: 0 });

  const time = await review(lib, "tune", "--comment", "pop", "--time", "0.5,1.25");
  assert.equal(time.exitCode, 0, time.error?.message);
  assert.deepEqual((time.fields["annotation"] as Record<string, unknown>)["anchor"], {
    time: { start: 0.5, end: 1.25 },
  });
  assert.match(time.human, / \(time 0\.5-1\.25 s\)/);
  const tune = parseReview(readFileSync(recordOf(lib, "tune"), "utf8"), "tune");
  const target = tune.annotations.at(-1)!.target as Record<string, unknown>;
  assert.equal(target["ag:version"], tuneSha);
  assert.equal((target["selector"] as Record<string, unknown>)["value"], "t=0.5,1.25");
});

test("an anchor outside the version names the selector and the valid range, and writes nothing", async () => {
  const { lib } = library();
  const cases: [string, string[], string][] = [
    [
      "walk",
      ["--frames", "2-9"],
      "ag:frames 2-9 is outside version 1 of walk: valid frames are 0-3",
    ],
    ["walk", ["--cell", "4,0"], "valid cells are columns 0-3, rows 0-0"],
    ["tune", ["--time", "1,3"], "the valid time range is 0-2.5 s"],
    ["walk", ["--time", "0,1"], "selector t="],
    ["walk", ["--frames", "5-2"], "--frames"],
    ["walk", ["--cell", "1"], "--cell"],
    ["tune", ["--time", "2,1"], "--time"],
  ];
  for (const [id, flags, message] of cases) {
    const before = readFileSync(recordOf(lib, id));
    const done = await review(lib, id, "--comment", "note", ...flags);
    assert.notEqual(done.exitCode, 0, flags.join(" "));
    assert.ok(done.error?.message.includes(message), `${done.error?.message} :: ${message}`);
    assert.deepEqual(readFileSync(recordOf(lib, id)), before, flags.join(" "));
  }
});

test("anchors go only with a new comment on a version", async () => {
  const { lib } = library();
  const before = readFileSync(recordOf(lib, "walk"));
  const done = await review(lib, "walk", "--resolve", "#1", "--frames", "0-1");
  assert.notEqual(done.exitCode, 0);
  assert.match(done.error?.message ?? "", /anchor a new --comment on a version/);
  assert.deepEqual(readFileSync(recordOf(lib, "walk")), before);
});
