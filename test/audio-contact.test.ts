/**
 * The contact sheet's waveform cell for an audio candidate (#481): one lane per channel, and the
 * staged run of an ambience (stereo) and an sfx (mono) shows it on contact.png.
 */
import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import wavefile from "wavefile";
import { waveformRaster } from "../src/audio/waveform.ts";
import { CELL_PX } from "../src/contact.ts";
import { CORE_REGISTRY } from "../src/extensions/registry.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { textWidth } from "../src/image/digits.ts";
import { decodeImage } from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import { planStage, stage } from "../src/loop.ts";
import { decodeWav } from "../src/media.ts";
import { defaultRoutes } from "../src/routes.ts";
import type { AssetSpec } from "../src/types.ts";
import { syntheticProfile, syntheticWorld } from "./fixtures/synthetic.ts";
import { toneWav } from "./fixtures/wav.ts";

const { WaveFile } = wavefile;
const temporary: string[] = [];
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

const INK = [30, 30, 36];

/** The rows of the raster region that hold ink. */
function inkRows(r: Raster, x0: number, y0: number, size: number): number[] {
  const rows: number[] = [];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = ((y0 + y) * r.width + x0 + x) * 4;
      if (INK.every((v, k) => r.data[i + k] === v)) {
        rows.push(y);
        break;
      }
    }
  return rows;
}

const half = CELL_PX / 2;

test("a stereo waveform has one lane per channel, each with ink", () => {
  const cell = waveformRaster(decodeWav(toneWav({ channels: 2 })), CELL_PX);
  assert.equal(cell.width, CELL_PX);
  assert.equal(cell.height, CELL_PX);
  const rows = inkRows(cell, 0, 0, CELL_PX);
  assert.ok(rows.some((y) => y < half - 1 - 4));
  assert.ok(rows.some((y) => y >= half + 4));
  assert.ok(!rows.includes(half - 1), "the separator between lanes holds no ink");
  assert.ok(rows.filter((y) => y < half).length > 1);
  assert.ok(rows.filter((y) => y >= half).length > 1);
});

test("a mono waveform is one lane over the full height", () => {
  const cell = waveformRaster(decodeWav(toneWav({ channels: 1 })), CELL_PX);
  const rows = inkRows(cell, 0, 0, CELL_PX);
  assert.ok(rows.some((y) => y < half - 10));
  assert.ok(rows.some((y) => y > half + 10));
  assert.ok(rows.includes(half - 1) || rows.includes(half));
});

test("a silent channel draws only its centre line", () => {
  const loud = Array.from({ length: 4410 }, (_, i) => Math.round(20000 * Math.sin(i / 7)));
  const wav = new WaveFile();
  wav.fromScratch(2, 44100, "16", [loud, new Array(4410).fill(0)]);
  const cell = waveformRaster(decodeWav(new Uint8Array(wav.toBuffer())), CELL_PX);
  const rows = inkRows(cell, 0, 0, CELL_PX);
  const lower = rows.filter((y) => y >= half);
  assert.equal(lower.length, 1);
  assert.ok(rows.filter((y) => y < half).length > 1);
  const again = waveformRaster(decodeWav(new Uint8Array(wav.toBuffer())), CELL_PX);
  assert.deepEqual(again.data, cell.data);
});

test("an empty channel draws only a centre line", () => {
  const cell = waveformRaster(
    {
      channels: [new Float32Array(0)],
      sampleRate: 44100,
      channelCount: 1,
      layout: "mono",
      bitDepth: "16",
    },
    CELL_PX,
  );
  assert.equal(inkRows(cell, 0, 0, CELL_PX).length, 1);
});

const LOUDNESS = { target: -23, tolerance: 1, truePeakCeiling: -1, encoderHeadroom: 1 };
const AUDIO_PROFILE = {
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

async function stageOf(spec: Record<string, unknown>) {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const provider = new ScriptedProvider({
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
  });
  const options = {
    spec: spec as unknown as AssetSpec,
    specDir: world.dir,
    bible: world.bible,
    bibleDir: world.bibleDir,
    profile: syntheticProfile(AUDIO_PROFILE as never),
    routes: defaultRoutes,
    provider,
    providerName: "scripted",
    generators: [...CORE_REGISTRY.kinds],
    runsDir: world.runsDir,
    candidates: 1,
  };
  planStage(options);
  const { run, runDir } = await stage(options);
  assert.deepEqual(run.errors, []);
  assert.equal(run.contactSheet, "contact.png");
  const sheet = decodeImage(new Uint8Array(await readFile(join(runDir, "contact.png"))));
  const number = Number.parseInt(run.candidates[0]!.id.replace(/\D/g, ""), 10);
  const x = 8 + textWidth(String(number), 3) + 8;
  return inkRows(sheet, x, 8, CELL_PX);
}

test("a staged ambience shows a two-lane waveform on the contact sheet", async () => {
  const rows = await stageOf({
    kind: "ambience",
    assetId: "wind",
    brief: "wind in pine trees",
    loopS: 2,
  });
  assert.ok(rows.filter((y) => y < half - 1).length > 1);
  assert.ok(rows.filter((y) => y >= half).length > 1);
  assert.ok(!rows.includes(half - 1));
});

test("a staged sfx shows a one-lane waveform over the full height", async () => {
  const rows = await stageOf({
    kind: "sfx",
    assetId: "door",
    brief: "a wooden door creaks open",
    maxDurationS: 2,
  });
  assert.ok(rows.some((y) => y < half - 2));
  assert.ok(rows.some((y) => y > half + 1));
  assert.ok(rows.includes(half - 1) || rows.includes(half));
});
