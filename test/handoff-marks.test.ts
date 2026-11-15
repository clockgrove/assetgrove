import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDefaultContainer, read as readKtx, write as writeKtx } from "ktx-parse";
import { validateBytes } from "gltf-validator";
import { writeToTarget } from "../src/handoff.ts";
import type { TargetWrite } from "../src/handoff.ts";
import { PRESETS } from "../src/handoff/presets/index.ts";
import type { HandoffPreset, PresetRegistry } from "../src/handoff/presets/index.ts";
import { createRaster, encodePng } from "../src/image/raster.ts";
import {
  DIGITAL_SOURCE_TYPES,
  embedDigitalSourceType,
  readDigitalSourceType,
  readMarkedModels,
} from "../src/metadata.ts";
import { parseGlb } from "../src/model3d/glb.ts";
import type { Provenance } from "../src/types.ts";
import { syntheticCharacter } from "./fixtures/glb.ts";
import { shelterSpec, syntheticProfile } from "./fixtures/synthetic.ts";

const types = DIGITAL_SOURCE_TYPES;
const prompt = "a secret prompt about dragons";
const provenance: Provenance = {
  digitalSourceType: types.generated,
  generator: "sprite-strip",
  route: "scripted",
  models: ["model-a", "model-b"],
  prompt,
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

function stripWrite(targetDir: string, handoff: unknown): TargetWrite {
  const profile = syntheticProfile({ handoff: handoff as never });
  delete profile.validator;
  return {
    profile,
    spec: shelterSpec,
    bibleVersion: "v1",
    output: {
      bytes: encodePng(createRaster(64, 8)),
      mediaType: "image/png",
      extension: "png",
      fields: { frames: { width: 16, height: 8, count: 4, durationMs: 120 } },
    },
    provenance,
    run: { runId: "r1", candidateId: "c1", pickedAt: "2026-01-01T00:00:02.000Z" },
    targetDir,
  };
}

const unmarked = encodePng(createRaster(2, 2));
function withExtra(content: Uint8Array): PresetRegistry {
  const manifest = PRESETS.get("manifest") as HandoffPreset;
  const extra: HandoffPreset = {
    ...manifest,
    name: "extra-image",
    write: () => [{ path: "assets/extra.png", content }],
    check: async () => [],
  };
  return { presets: new Map([...PRESETS, ["extra-image", extra]]) };
}

test("a handed-off PNG names the provenance's models in its mark", async () => {
  const target = await mkdtemp(join(tmpdir(), "assetgrove-marks-"));
  await writeToTarget(stripWrite(target, [{ preset: "atlas-json", options: { shape: "array" } }]));
  const bytes = new Uint8Array(await readFile(join(target, "assets/source/fern/shelter.png")));
  assert.equal(readDigitalSourceType(bytes, "image/png"), types.generated);
  assert.equal(readMarkedModels(bytes, "image/png"), "model-a; model-b");
  assert.ok(!Buffer.from(bytes).includes(Buffer.from(prompt)));
});

test("a preset's file in a markable format without the mark fails the check with exit 6", async () => {
  const target = await mkdtemp(join(tmpdir(), "assetgrove-marks-"));
  await assert.rejects(
    writeToTarget({
      ...stripWrite(target, [{ preset: "extra-image" }]),
      registry: withExtra(unmarked),
    }),
    (error: { code?: string; problems?: { problem: string }[] }) =>
      error.code === "handoff_check_failed" &&
      error.problems!.some((p) => p.problem.includes("assets/extra.png lacks the AI mark")),
  );
  const marked = embedDigitalSourceType(unmarked, "image/png", types.generated, {
    models: provenance.models,
  });
  await writeToTarget({
    ...stripWrite(await mkdtemp(join(tmpdir(), "assetgrove-marks-")), [{ preset: "extra-image" }]),
    registry: withExtra(marked),
  });
});

test("a GLB and a glTF carry KHR_xmp_json_ld the Khronos validator accepts", async () => {
  const glb = embedDigitalSourceType(syntheticCharacter(), "model/gltf-binary", types.generated, {
    models: ["model-a"],
  });
  const report = await validateBytes(glb, { format: "glb" });
  assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages));
  const json = parseGlb(glb).json as { extensionsUsed: string[] };
  assert.ok(json.extensionsUsed.includes("KHR_xmp_json_ld"));
  assert.equal(readDigitalSourceType(glb, "model/gltf-binary"), types.generated);
  assert.equal(readMarkedModels(glb, "model/gltf-binary"), "model-a");
  const gltf = embedDigitalSourceType(
    Buffer.from(JSON.stringify({ asset: { version: "2.0" } })),
    "model/gltf+json",
    types.generated,
    { models: ["model-a"] },
  );
  assert.equal(readDigitalSourceType(gltf, "model/gltf+json"), types.generated);
  assert.equal(readMarkedModels(gltf, "model/gltf+json"), "model-a");
  const again = embedDigitalSourceType(glb, "model/gltf-binary", types.generated, {
    models: ["model-a"],
  });
  assert.deepEqual(Buffer.from(again), Buffer.from(glb));
});

test("a KTX2 carries the key-value entry ktx-parse reads back", () => {
  const container = createDefaultContainer();
  container.pixelWidth = 2;
  container.pixelHeight = 2;
  container.levels = [{ levelData: new Uint8Array(16), uncompressedByteLength: 16 }];
  const plain = writeKtx(container);
  const marked = embedDigitalSourceType(plain, "image/ktx2", types.generated, {
    models: ["model-a"],
  });
  const long = embedDigitalSourceType(plain, "image/ktx2", types.generated, {
    models: Array.from({ length: 12 }, (_, i) => `provider/model-number-${i}`),
  });
  assert.equal(readMarkedModels(long, "image/ktx2")?.split("; ").length, 12);
  assert.equal(readKtx(long).levels[0]!.levelData.length, 16);
  const read = readKtx(marked);
  assert.match(
    Buffer.from(read.keyValue["XMP"] as Uint8Array).toString("utf8"),
    /trainedAlgorithmicMedia/,
  );
  assert.equal(readDigitalSourceType(marked, "image/ktx2"), types.generated);
  assert.equal(readMarkedModels(marked, "image/ktx2"), "model-a");
  assert.deepEqual(read.levels[0]!.levelData, new Uint8Array(16));
  const again = embedDigitalSourceType(marked, "image/ktx2", types.generated, {
    models: ["model-a"],
  });
  assert.deepEqual(Buffer.from(again), Buffer.from(marked));
});
