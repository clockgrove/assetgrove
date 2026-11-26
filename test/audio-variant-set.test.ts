/**
 * Variant sets of `sfx` (#481, plan assumptions 21 and 22): the ids a set's members must have, and
 * `audit`'s free `audio:set-loudness` check over the members sharing a subject, run through the
 * CLI in a temporary Git repository on the scripted audio provider.
 */
import "./fixtures/env.ts";
import { useAttended } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { decodeAudio, encodeWav } from "../src/audio/engine.ts";
import { sfxGenerator, variantIds } from "../src/audio/kinds.ts";
import { audioSetSpread } from "../src/audio/profile.ts";
import {
  AUDIO_SCRIPT,
  audioProject,
  cleanAudioProjects,
  cli,
  doc,
  pickedAudio,
} from "./fixtures/audio-project.ts";
import type { AudioProject } from "./fixtures/audio-project.ts";

after(cleanAudioProjects);

const spec = (n: number, extra: Record<string, unknown> = {}) => ({
  kind: "sfx",
  assetId: `footstep-0${n}`,
  subject: "footstep",
  variant: n,
  brief: "a footstep on gravel",
  maxDurationS: 1,
  ...extra,
});

test("variantIds plans a set's member ids in order", () => {
  assert.deepEqual(variantIds("footstep", 3), ["footstep-01", "footstep-02", "footstep-03"]);
  assert.equal(variantIds("hit", 12)[11], "hit-12");
});

test("a variant's assetId must be <subject>-NN, and the refusal names it", () => {
  const parse = (s: Record<string, unknown>) => sfxGenerator.specSchema!.safeParse(s);
  assert.equal(parse(spec(2)).success, true);
  for (const bad of [spec(2, { assetId: "footstep-2" }), spec(2, { assetId: undefined })]) {
    const result = parse(bad);
    assert.equal(result.success, false);
    assert.match(result.error!.issues.map((i) => i.message).join(), /footstep-02/);
  }
  assert.equal(parse(spec(2, { subject: undefined })).success, false);
  assert.equal(parse(spec(100, { assetId: "footstep-100" })).success, false);
});

test("a variant spec with the wrong id is refused at stage and stage --dry-run with exit 2", async () => {
  useAttended();
  const p = await audioProject();
  const path = await p.spec({ ...spec(2), assetId: "footstep-2" });
  for (const extra of [[], ["--dry-run"]]) {
    const run = await cli([
      ...["stage", "--spec", path, "--bible", p.bible, "--profile", p.profilePath],
      ...["--runs", p.runs, "--candidates", "1", "--provider-script", AUDIO_SCRIPT, "--json"],
      ...extra,
    ]);
    assert.equal(run.code, 2, run.stdout + run.stderr);
    assert.match(run.stdout + run.stderr, /footstep-02/);
  }
});

test("the profile's set spread needs no loudness block", () => {
  assert.equal(audioSetSpread({ name: "x" } as never), 2);
  assert.equal(audioSetSpread({ name: "x", audio: { setSpreadLu: 3 } } as never), 3);
});

function wavOf(dir: string, id: string): string {
  const found = (folder: string): string | undefined => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        const hit = found(path);
        if (hit) return hit;
      } else if (entry.name === `${id}.wav`) return path;
    }
    return undefined;
  };
  const file = found(dir);
  assert.ok(file, `${id}.wav in the library`);
  return file;
}

async function audit(p: AudioProject, ...more: string[]) {
  return cli(
    [
      ...["audit", "asset://test-grove/by-subject/footstep/", "--target", p.target],
      ...["--runs", p.runs, "--provider-script", AUDIO_SCRIPT, "--json", ...more],
    ],
    p.target,
  );
}

test("audit's loudness check passes a variant set and fails the member 6 dB quieter", async () => {
  useAttended();
  const p = await audioProject();
  for (const n of [1, 2, 3]) {
    const { staged } = await pickedAudio(p, spec(n));
    assert.equal(staged["candidates"][0].fields.audio.requested.variant, n);
  }

  await mkdir(join(p.target, ".assetgrove"), { recursive: true });
  await copyFile(p.profilePath, join(p.target, ".assetgrove", "profile.json"));

  const run = await audit(p, "--checks", "loudness");
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const passing = doc(run);
  assert.equal(passing.loudness.length, 1);
  const set = passing.loudness[0];
  assert.equal(set.subject, "footstep");
  assert.deepEqual(
    set.members.map((m: { id: string }) => m.id),
    variantIds("footstep", 3),
  );
  assert.deepEqual(
    set.reasons.map((r: { check: string; passed: boolean }) => [r.check, r.passed]),
    [1, 2, 3].map(() => ["audio:set-loudness", true]),
  );
  assert.equal(passing.spentUsd, 0);

  const file = wavOf(p.target, "footstep-02");
  const item = decodeAudio(new Uint8Array(await readFile(file)));
  const gain = 10 ** (-6 / 20);
  item.channels = item.channels.map((c) => c.map((v) => v * gain));
  await writeFile(file, encodeWav(item));

  const failed = await audit(p, "--checks", "loudness");
  assert.equal(failed.code, 0, failed.stdout + failed.stderr);
  const reasons = doc(failed).loudness[0].reasons as { passed: boolean; reason: string }[];
  assert.deepEqual(
    reasons.map((r) => r.passed),
    [true, false, true],
  );
  assert.match(reasons[1]!.reason, /^footstep-02 is /);
  assert.match(failed.stdout, /footstep-02/);

  const byDefault = await audit(p);
  assert.equal(byDefault.code, 0, byDefault.stdout + byDefault.stderr);
  assert.equal(doc(byDefault).loudness[0].reasons.length, 3);
});
