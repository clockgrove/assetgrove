/**
 * Ogg renditions for packs (#521): `context.audio.oggRendition` builds the deterministic, marked
 * Ogg a rendition makes, and a hand-off gives an Ogg a preset writes a C2PA sidecar beside it.
 */
import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { z } from "zod";
import { encodeWav, readWavLoop } from "../src/audio/engine.ts";
import type { AudioItem } from "../src/audio/engine.ts";
import { sidecarCredentialProblem } from "../src/credentials.ts";
import { createExtensionContext } from "../src/extension/context.ts";
import { writeToTarget } from "../src/handoff.ts";
import { markableMediaType, markProblems } from "../src/handoff/mark-check.ts";
import { PRESETS } from "../src/handoff/presets/index.ts";
import type { HandoffPreset, PresetRegistry } from "../src/handoff/presets/index.ts";
import { DIGITAL_SOURCE_TYPES, embedDigitalSourceType } from "../src/metadata.ts";
import type { Provenance } from "../src/types.ts";
import { gitTarget } from "./fixtures/git.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";

const temporary: string[] = [];
after(async () => {
  await Promise.all(temporary.map((d) => rm(d, { recursive: true, force: true })));
});

const MODELS = ["stable-audio-2.5"];
const { audio } = createExtensionContext("test");

function master(): Uint8Array {
  const rate = 22050;
  const tone = new Float64Array(rate);
  for (let i = 0; i < rate; i++) tone[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / rate);
  const item: AudioItem = {
    name: "m",
    channels: [tone],
    sampleRate: rate,
    bitDepth: "16",
    meta: {},
  };
  return embedDigitalSourceType(
    encodeWav(item, { loop: { start: 0, end: rate } }),
    "audio/wav",
    DIGITAL_SOURCE_TYPES.generated,
    { models: MODELS },
  );
}

test("oggRendition is deterministic, an Ogg, marked, and reports its build", async () => {
  const wav = master();
  const first = await audio.oggRendition(wav, { quality: 4 });
  const again = await audio.oggRendition(wav, { quality: 4 });
  assert.deepEqual(first.bytes, again.bytes);
  assert.equal(first.digest, again.digest);
  assert.equal(Buffer.from(first.bytes.subarray(0, 4)).toString("latin1"), "OggS");
  assert.deepEqual(
    markProblems("rendition.ogg", first.bytes, "audio/ogg", {
      digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
      models: MODELS,
    }),
    [],
  );
  const recipe = (first.build["recipe"] as { op: string; params: unknown }[]).find(
    (s) => s.op === "encode",
  );
  assert.deepEqual(recipe?.params, { quality: 4 });
  assert.notDeepEqual((await audio.oggRendition(wav)).bytes, first.bytes, "quality changes it");
});

test("wavLoop reads a master's smpl loop", () => {
  assert.deepEqual(audio.wavLoop(master()), { start: 0, end: 22050 });
});

const provenance: Provenance = {
  digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
  generator: "ambience",
  route: "scripted",
  models: MODELS,
  prompt: "wind",
  parameters: {},
  requestIds: ["req-1"],
  referenceHashes: [],
  bibleVersion: "synthetic-1",
  license: "MIT",
  providerTerms: [],
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:01.000Z",
  costUsd: 0,
  calls: [],
};

const oggPreset: HandoffPreset = {
  name: "ext:ogg",
  optionsSchema: z.strictObject({}),
  write: async (ctx) => [
    {
      path: "audio/wind.ogg",
      content: (await audio.oggRendition(ctx.mediaBytes ?? master())).bytes,
    },
  ],
  check: async () => [],
};
const registry: PresetRegistry = { presets: new Map([...PRESETS, ["ext:ogg", oggPreset]]) };

async function handOff() {
  const targetDir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-handoff-ogg-")));
  temporary.push(targetDir);
  await gitTarget(targetDir);
  const profile = syntheticProfile({
    layout: {
      media: "audio/{{spec.assetId}}.{{output.extension}}",
      manifest: "audio/{{spec.assetId}}.json",
    },
    manifest: {
      assetManifestVersion: 1,
      assetId: "{{spec.assetId}}",
      review: { status: "pending" },
      contentHash: "{{output.sha256}}",
    },
  });
  delete profile.validator;
  profile.handoff = [{ preset: "manifest" }, { preset: "ext:ogg" }];
  const write = () =>
    writeToTarget({
      profile,
      spec: { kind: "ambience", assetId: "wind", fields: {} } as never,
      bibleVersion: "synthetic-1",
      output: { bytes: master(), mediaType: "audio/wav", extension: "wav", fields: {} },
      provenance: { ...provenance },
      run: { runId: "r1", candidateId: "c1", pickedAt: "2026-01-01T00:00:02.000Z" },
      targetDir,
      registry,
    });
  return { targetDir, write };
}

test("a hand-off signs a C2PA sidecar beside an Ogg a preset writes and keeps it when unchanged", async () => {
  const { targetDir, write } = await handOff();
  const result = await write();
  const entry = result.handoff.find((h) => h.preset === "ext:ogg")!;
  assert.deepEqual(entry.files, ["audio/wind.ogg", "audio/wind.c2pa"]);
  assert.ok(result.contentCredentials?.files.includes("audio/wind.c2pa"));
  assert.ok(result.files.includes("audio/wind.c2pa"));
  assert.equal(markableMediaType("audio/wind.ogg"), "audio/ogg");

  const ogg = new Uint8Array(await readFile(join(targetDir, "audio", "wind.ogg")));
  const manifest = new Uint8Array(await readFile(join(targetDir, "audio", "wind.c2pa")));
  assert.equal(
    await sidecarCredentialProblem("audio/wind.c2pa", manifest, ogg, {
      digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
      models: MODELS,
    }),
    undefined,
  );
  const wav = new Uint8Array(await readFile(join(targetDir, "audio", "wind.wav")));
  assert.deepEqual(readWavLoop(wav), { start: 0, end: 22050 }, "the delivered WAV keeps its loop");

  await write();
  assert.deepEqual(new Uint8Array(await readFile(join(targetDir, "audio", "wind.c2pa"))), manifest);
});
