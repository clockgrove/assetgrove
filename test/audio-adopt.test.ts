/**
 * `library adopt` takes a WAV (#481, acceptance 8): a hand edit of a picked audio asset's working
 * media becomes its next version, judged on its own bytes by the kind's master checks, its
 * `human-edit` step recording sample hashes.
 */
import "./fixtures/env.ts";
import { useAttended } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { copyFile, cp, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { after, test } from "node:test";
import { decodeAudio, deriveAudio, encodeWav, sampleHash } from "../src/audio/engine.ts";
import {
  audioProject,
  cleanAudioProjects,
  cli,
  confirm,
  doc,
  pickedAudio,
} from "./fixtures/audio-project.ts";
import type { AudioProject } from "./fixtures/audio-project.ts";

after(cleanAudioProjects);

const SPEC = { kind: "sfx", assetId: "tick", brief: "a clock tick", maxDurationS: 0.25 };

/** A picked sfx, a copy of its original, and its card and working media. */
async function picked(p: AudioProject) {
  const { staged } = await pickedAudio(p, SPEC);
  // `adopt` renders the hand-off again from the run, found under the target's runs directory.
  const runDir = staged["runDir"] as string;
  await cp(runDir, join(p.target, ".assetgrove/runs", basename(runDir)), { recursive: true });
  const media = join(p.target, "assets/tick.wav");
  const original = join(p.dir, "original.wav");
  await copyFile(media, original);
  return { media, original, card: join(p.target, "assets/tick.md") };
}

const adopt = (p: AudioProject, card: string, original: string) => [
  ...["library", "adopt", card, "--original", original, "--target", p.target, "--json"],
];

test("library adopt takes an edited WAV as the next version", async () => {
  useAttended();
  const p = await audioProject();
  const { media, original, card } = await picked(p);
  const before = decodeAudio(new Uint8Array(await readFile(original)));
  const edited = deriveAudio(
    before,
    before.channels.map((c) => c.map((v, i) => (i % 7 === 0 ? v * 0.97 : v) * 0.98)),
  );
  await writeFile(media, encodeWav(edited));

  const args = adopt(p, card, original);
  const asked = await cli(args, p.target);
  assert.equal(asked.code, 8, asked.stdout + asked.stderr);
  await confirm(doc(asked)["error"].confirmation.id as string);
  const done = await cli(args, p.target);
  assert.equal(done.code, 0, done.stdout + done.stderr);
  const out = doc(done);
  assert.equal(out["version"], 2);

  const names = out["qa"].map((r: { check: string }) => r.check);
  assert.deepEqual(names, [
    "audio:format",
    "audio:duration",
    "audio:true-peak",
    "audio:loudness",
    "audio:silence",
    "audio:fake-stereo",
  ]);
  assert.ok(
    out["qa"].every((r: { passed: boolean }) => r.passed),
    JSON.stringify(out["qa"]),
  );
  assert.deepEqual(
    out["notRun"].map((r: { check: string }) => r.check),
    ["audio:fade", "audio:loop"],
  );

  const provenance = JSON.parse(
    await readFile(join(p.target, "assets/tick.wav.provenance.json"), "utf8"),
  );
  const step = provenance.steps.find((s: { op: string }) => s.op === "human-edit");
  assert.deepEqual(step.inputs, [sampleHash(before)]);
  assert.deepEqual(step.outputs, [sampleHash(edited)]);
});

test("library adopt refuses an edited WAV that breaks a check", async () => {
  useAttended();
  const p = await audioProject();
  const { media, original, card } = await picked(p);
  const before = decodeAudio(new Uint8Array(await readFile(original)));
  const stereo = deriveAudio(before, [before.channels[0]!, before.channels[0]!.map((v) => -v)]);
  await writeFile(media, encodeWav(stereo));
  const refused = await cli(adopt(p, card, original), p.target);
  assert.equal(refused.code, 5, refused.stdout + refused.stderr);
  const error = doc(refused)["error"];
  assert.equal(error.code, "qa_found_nothing");
  assert.match(error.message, /audio:format/);
  assert.equal(sampleHash(stereo).length, 64);
});
