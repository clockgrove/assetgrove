import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import wavefile from "wavefile";
import { developmentSigner, readCredentials, signCredentials } from "../src/credentials.ts";
import { writeToTarget } from "../src/handoff.ts";
import type { TargetWrite } from "../src/handoff.ts";
import { markProblems } from "../src/handoff/mark-check.ts";
import {
  DIGITAL_SOURCE_TYPES,
  embedDigitalSourceType,
  readDigitalSourceType,
  readMarkedModels,
} from "../src/metadata.ts";
import type { Provenance } from "../src/types.ts";
import { shelterSpec, syntheticProfile } from "./fixtures/synthetic.ts";
import { riffChunkIds, toneWav, withoutChunk } from "./fixtures/wav.ts";

const { WaveFile } = wavefile;
const generated = DIGITAL_SOURCE_TYPES.generated;
const models = ["model-a", "model-b"];
const expected = { digitalSourceType: generated, models } as const;
const temp = (name: string) => mkdtempSync(join(tmpdir(), `assetgrove-wav-${name}-`));

const provenance: Provenance = {
  digitalSourceType: generated,
  generator: "sprite-strip",
  route: "scripted",
  models,
  prompt: "a prompt",
  parameters: {},
  requestIds: [],
  referenceHashes: [],
  bibleVersion: "synthetic-1",
  license: "MIT",
  providerTerms: [],
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:01.000Z",
  costUsd: 0,
  calls: [],
};

function handoff(targetDir: string, bytes: Uint8Array): TargetWrite {
  const profile = syntheticProfile();
  delete profile.validator;
  return {
    profile,
    spec: shelterSpec,
    bibleVersion: "v1",
    output: {
      bytes,
      mediaType: "audio/wav",
      extension: "wav",
      fields: {
        frames: { width: 16, height: 8, count: 1, durationMs: 120 },
        anchor: { x: 8, y: 8 },
        bounds: { x: 0, y: 0, width: 16, height: 8 },
      },
    },
    provenance,
    run: { runId: "r1", candidateId: "c1", pickedAt: "2026-01-01T00:00:02.000Z" },
    targetDir,
  };
}

function samples(bytes: Uint8Array): unknown {
  return new WaveFile(bytes).getSamples();
}

for (const [name, options] of [
  ["mono 16-bit", { channels: 1, bitDepth: "16" }],
  ["stereo 24-bit", { channels: 2, bitDepth: "24" }],
] as const) {
  test(`${name} WAV: the mark round-trips and the samples are unchanged`, () => {
    const wav = toneWav(options);
    const marked = embedDigitalSourceType(wav, "audio/wav", generated, { models });
    assert.ok(riffChunkIds(marked).includes("_PMX"));
    assert.equal(readDigitalSourceType(marked, "audio/wav"), generated);
    assert.equal(readMarkedModels(marked, "audio/wav"), "model-a; model-b");
    assert.deepEqual(samples(marked), samples(wav));
    assert.equal(readDigitalSourceType(wav, "audio/wav"), undefined);
    const again = embedDigitalSourceType(marked, "audio/wav", generated, { models });
    assert.deepEqual(again, marked);
  });
}

test("WAV mark check passes, and fails once the _PMX chunk is removed", () => {
  const marked = embedDigitalSourceType(toneWav(), "audio/wav", generated, { models });
  assert.deepEqual(markProblems("a.wav", marked, "audio/wav", expected), []);
  const problems = markProblems("a.wav", withoutChunk(marked, "_PMX"), "audio/wav", expected);
  assert.deepEqual(
    problems.map((p) => p.code),
    ["mark_missing"],
  );
});

test("a WAV hand-off writes Content Credentials and the mark", async () => {
  const target = temp("handoff");
  const result = await writeToTarget(handoff(target, toneWav()));
  const bytes = new Uint8Array(await readFile(join(target, "assets/source/fern/shelter.wav")));
  const read = await readCredentials(bytes, "audio/wav");
  assert.equal(read?.state, "Valid");
  assert.deepEqual(read?.failures, []);
  assert.equal(read?.actions[0]?.action, "c2pa.created");
  assert.ok(riffChunkIds(bytes).includes("_PMX"));
  assert.deepEqual(markProblems("shelter.wav", bytes, "audio/wav", expected), []);
  assert.deepEqual(JSON.stringify(result).includes("mark_missing"), false);
  const stripped = withoutChunk(bytes, "_PMX");
  assert.deepEqual(
    markProblems("shelter.wav", stripped, "audio/wav", expected).map((p) => p.code),
    ["mark_missing"],
  );
});

test("a vendor manifest in the source WAV becomes a componentOf ingredient", async () => {
  const signer = await developmentSigner(temp("signer"));
  const claim = { digitalSourceType: DIGITAL_SOURCE_TYPES.human, models: [], title: "vendor.wav" };
  const vendor = await signCredentials(toneWav(), "audio/wav", claim, signer, "1");
  assert.ok(riffChunkIds(vendor).includes("C2PA"));
  const marked = embedDigitalSourceType(vendor, "audio/wav", generated, { models });
  assert.ok(riffChunkIds(marked).includes("C2PA"), "the vendor chunk survives the mark");
  assert.deepEqual(samples(marked), samples(vendor));

  const ours = { digitalSourceType: generated, models, title: "shelter.wav" };
  const signed = await signCredentials(marked, "audio/wav", ours, signer, "1");
  const read = await readCredentials(signed, "audio/wav");
  assert.equal(read?.state, "Valid");
  assert.deepEqual(read?.failures, []);
  assert.equal(read?.actions[0]?.action, "c2pa.created");
  assert.deepEqual(
    read?.ingredients.map((i) => i.relationship),
    ["componentOf"],
  );

  const plain = await signCredentials(toneWav(), "audio/wav", ours, signer, "1");
  assert.deepEqual((await readCredentials(plain, "audio/wav"))?.ingredients, []);
});
