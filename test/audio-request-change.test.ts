/**
 * `request_change` on an audio asset (#481): a `t=<start>,<end> : <note>` region regenerates the
 * asset from its brief with the note, on the scripted audio provider in a temporary Git repository.
 * The annotation carries the media-fragment time selector, a pick of the new candidate appends
 * version 2 with `answers`, and a box region or a span past the duration is refused (exit 2).
 */
import "./fixtures/env.ts";
import { useAttended } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseReview } from "../src/library/review.ts";
import { parseRegion } from "../src/regions.ts";
import {
  AUDIO_SCRIPT,
  audioProject,
  cleanAudioProjects,
  cli,
  confirm,
  doc,
  pickAudio,
  pickedAudio,
} from "./fixtures/audio-project.ts";
import type { AudioProject } from "./fixtures/audio-project.ts";

after(cleanAudioProjects);

const STING = {
  kind: "music",
  assetId: "sting",
  brief: "a bright discovery sting",
  form: "cue",
  durationS: 1,
};

async function pickedSting(): Promise<AudioProject> {
  useAttended();
  const p = await audioProject();
  await pickedAudio(p, STING);
  return p;
}

function change(p: AudioProject, region: string, bible = true): string[] {
  return [
    ...["request-change", join(p.target, "assets", "sting.md"), "--region", region],
    ...(bible ? ["--bible", p.bible] : []),
    ...["--runs", p.runs, "--provider-script", AUDIO_SCRIPT, "--candidates", "1", "--json"],
  ];
}

test("request_change on an audio asset regenerates from the brief with the note, and its pick answers it", async () => {
  const p = await pickedSting();
  const args = change(p, "t=0.2,0.6 : softer attack");
  const asked = await cli(args, p.target);
  assert.equal(asked.code, 8, asked.stdout + asked.stderr);
  await confirm(doc(asked)["error"].confirmation.id as string);
  const done = await cli(args, p.target);
  assert.equal(done.code, 0, done.stdout + done.stderr);
  const result = doc(done);
  assert.equal(result["job"], "audio-round");
  assert.equal(result["compareSheet"], undefined);
  assert.ok(result["contactSheet"]);
  assert.equal(result["candidates"].length, 1);

  const run = JSON.parse(await readFile(join(result["runDir"], "run.json"), "utf8")) as {
    candidates: Array<{ provenance: { prompt: string } }>;
  };
  const provenance = run.candidates[0]!.provenance;
  assert.match(provenance.prompt, /a bright discovery sting/);
  assert.match(provenance.prompt, /From 0\.2 s to 0\.6 s: softer attack/);

  const review = join(p.target, "assets", "sting.review.json");
  const before = parseReview(await readFile(review, "utf8"), review);
  const editing = before.annotations.filter((a) => a.motivation === "editing");
  assert.equal(editing.length, 1);
  const target = editing[0]!.target as { selector: Record<string, unknown> };
  assert.deepEqual(target.selector, {
    type: "FragmentSelector",
    conformsTo: "http://www.w3.org/TR/media-frags/",
    value: "t=0.2,0.6",
  });

  await pickAudio(p, result["runDir"] as string);
  const after = parseReview(await readFile(review, "utf8"), review);
  assert.equal(after.versions.length, 2);
  assert.deepEqual(
    after.versions[1]!.answers,
    editing.map((a) => a.id),
  );
});

test("request_change on an audio asset refuses a box region and a span past the duration", async () => {
  const p = await pickedSting();
  const box = await cli(change(p, "0,0,10,10 : brighter"), p.target);
  assert.equal(box.code, 2, box.stdout + box.stderr);
  assert.match(box.stdout + box.stderr, /t=<start>,<end>/);
  const past = await cli(change(p, "t=0,5 : longer"), p.target);
  assert.equal(past.code, 2, past.stdout + past.stderr);
  assert.match(past.stdout + past.stderr, /outside/);
});

test("request_change on an audio asset with no style bible asks for --bible", async () => {
  const p = await pickedSting();
  const asked = await cli(change(p, "t=0.2,0.6 : softer", false), p.target);
  assert.equal(asked.code, 2, asked.stdout + asked.stderr);
  assert.match(asked.stdout, /--bible/);
});

test("parseRegion reads a time region and refuses a malformed one", () => {
  const region = parseRegion("t=0.5,1.25 : softer");
  assert.deepEqual(region.shape, { kind: "time", start: 0.5, end: 1.25 });
  assert.equal(region.note, "softer");
  assert.deepEqual(parseRegion("t=npt:0,2 : x").shape, { kind: "time", start: 0, end: 2 });
  for (const bad of [
    "t=1,1 : x",
    "t=2,1 : x",
    "t=a,2 : x",
    "t=1 : x",
    "t=-1,2 : x",
    "t=0,1 frame 2 : x",
    "t=0,1 view 2 : x",
    "t=0,1 ref a.png : x",
    "t=0,1",
  ])
    assert.throws(() => parseRegion(bad), /malformed region/, bad);
});
