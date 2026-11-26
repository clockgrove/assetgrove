/**
 * Loop points in an audio master (#521): `encodeWav` writes a RIFF `smpl` chunk, `readWavLoop`
 * reads it back, the ambience and music-loop kinds carry it, and the mark and the C2PA signature
 * keep it.
 */
import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { decodeAudio, encodeWav, readWavLoop } from "../src/audio/engine.ts";
import type { AudioItem } from "../src/audio/engine.ts";
import { credentialed, developmentSigner, readCredentials } from "../src/credentials.ts";
import { CORE_REGISTRY } from "../src/extensions/registry.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { planStage, stage } from "../src/loop.ts";
import { DIGITAL_SOURCE_TYPES, embedDigitalSourceType } from "../src/metadata.ts";
import { defaultRoutes } from "../src/routes.ts";
import type { AssetSpec } from "../src/types.ts";
import { syntheticProfile, syntheticWorld } from "./fixtures/synthetic.ts";
import { riffChunkIds, toneWav } from "./fixtures/wav.ts";

const temporary: string[] = [];
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

const item = (frames: number, sampleRate = 44100): AudioItem => ({
  name: "loop",
  channels: [new Float64Array(frames).fill(0.1)],
  sampleRate,
  bitDepth: "16",
  meta: {},
});

test("encodeWav writes one forward loop in a smpl chunk and readWavLoop reads it", () => {
  const bytes = encodeWav(item(1000), { loop: { start: 0, end: 1000 } });
  assert.ok(riffChunkIds(bytes).includes("smpl"));
  assert.deepEqual(readWavLoop(bytes), { start: 0, end: 1000 });
  const view = Buffer.from(bytes);
  const at = view.indexOf("smpl") + 8;
  assert.equal(view.readUInt32LE(at + 8), Math.round(1e9 / 44100), "dwSamplePeriod");
  assert.equal(view.readUInt32LE(at + 12), 60, "dwMIDIUnityNote");
  assert.equal(view.readUInt32LE(at + 28), 1, "one loop");
  assert.equal(view.readUInt32LE(at + 36 + 4), 0, "forward");
});

test("a WAV without a loop, and bytes that are no WAV, have no loop", () => {
  const plain = encodeWav(item(1000));
  assert.equal(riffChunkIds(plain).includes("smpl"), false);
  assert.equal(readWavLoop(plain), undefined);
  assert.equal(readWavLoop(new Uint8Array([1, 2, 3])), undefined);
  assert.equal(readWavLoop(toneWav()), undefined);
});

test("the loop does not change the samples", () => {
  const looped = decodeAudio(encodeWav(item(500), { loop: { start: 0, end: 500 } }));
  const plain = decodeAudio(encodeWav(item(500)));
  assert.deepEqual(looped.channels, plain.channels);
});

const LOUDNESS = { target: -23, tolerance: 1, truePeakCeiling: -1, encoderHeadroom: 1 };
const PROFILE = {
  audio: { loudness: LOUDNESS },
  layout: {
    media: "audio/{{spec.assetId}}.{{output.extension}}",
    manifest: "audio/{{spec.assetId}}.json",
  },
  manifest: {
    assetManifestVersion: 1,
    assetId: "{{spec.assetId}}",
    kind: "{{spec.kind}}",
    source: {
      kind: "generated",
      path: "{{output.path}}",
      mediaType: "{{output.mediaType}}",
      tool: "assetgrove",
    },
    license: "{{profile.license}}",
    review: { status: "pending" },
    contentHash: "{{output.sha256}}",
  },
};
const SPECS: Record<string, Record<string, unknown>> = {
  sfx: { kind: "sfx", assetId: "door", brief: "a wooden door creaks open", maxDurationS: 2 },
  ambience: { kind: "ambience", assetId: "wind", brief: "wind in pine trees", loopS: 2 },
  musicLoop: {
    kind: "music",
    assetId: "theme",
    brief: "a calm village theme",
    form: "track",
    loop: { bpm: 240, bars: 2, beatsPerBar: 4 },
  },
  track: {
    kind: "music",
    assetId: "credits",
    brief: "warm closing credits",
    form: "track",
    durationS: 1.5,
  },
};

async function masterOf(spec: Record<string, unknown>): Promise<Uint8Array> {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const options = {
    spec: spec as unknown as AssetSpec,
    specDir: world.dir,
    bible: world.bible,
    bibleDir: world.bibleDir,
    profile: syntheticProfile(PROFILE as never),
    routes: defaultRoutes,
    provider: new ScriptedProvider({
      image: () => {
        throw new Error("no image call expected");
      },
      vision: () => {
        throw new Error("no vision call expected");
      },
      audio: (request) => ({
        audio: {
          mediaType: "audio/wav",
          bytes: toneWav({ channels: 2, length: Math.round((request.durationS ?? 1) * 44100) }),
        },
        costUsd: 0.08,
      }),
    }),
    providerName: "scripted",
    generators: [...CORE_REGISTRY.kinds],
    runsDir: world.runsDir,
    candidates: 1,
  };
  planStage(options);
  const { run, runDir } = await stage(options);
  return new Uint8Array(await readFile(join(runDir, run.candidates[0]!.file)));
}

for (const name of ["ambience", "musicLoop"]) {
  test(`the ${name} master carries its whole length as a loop`, async () => {
    const master = await masterOf(SPECS[name]!);
    const frames = decodeAudio(master).channels[0]!.length;
    assert.deepEqual(readWavLoop(master), { start: 0, end: frames });
  });
}

for (const name of ["sfx", "track"]) {
  test(`the ${name} master carries no loop`, async () => {
    const master = await masterOf(SPECS[name]!);
    assert.equal(readWavLoop(master), undefined);
  });
}

test("marking a loop master and signing it with C2PA keep its loop", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-loop-")));
  temporary.push(dir);
  const bytes = encodeWav(item(2000), { loop: { start: 0, end: 2000 } });
  const marked = embedDigitalSourceType(bytes, "audio/wav", DIGITAL_SOURCE_TYPES.generated, {
    models: ["stable-audio-2.5"],
  });
  assert.deepEqual(readWavLoop(marked), { start: 0, end: 2000 });
  const signed = await credentialed(
    marked,
    "audio/wav",
    {
      digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
      models: ["stable-audio-2.5"],
      title: "loop.wav",
    },
    await developmentSigner(join(dir, "state")),
    "0.0.0",
  );
  assert.notDeepEqual(signed, marked);
  assert.ok((await readCredentials(signed, "audio/wav")) !== undefined, "it is signed");
  assert.deepEqual(readWavLoop(signed), { start: 0, end: 2000 });
});
