/**
 * A kind's media trait (#518): core's image, model and audio kinds declare it, a pack kind that
 * declares none is an image kind, and the features that need a raster ask the trait. A fixture
 * pack's `fx:sound` (audio) is staged from a synthetic WAV: its checks read the decoded PCM, sample
 * rate and channel layout, the candidate carries the AI mark in its `_PMX` chunk, it gets no
 * contact-sheet cell, and plan and vary refuse it.
 */
import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import wavefile from "wavefile";
import { BIBLE_PRESETS, serializeBible } from "../src/bible.ts";
import {
  CORE_ENTRY,
  CORE_REGISTRY,
  ExtensionError,
  ExtensionRegistry,
  checkExtension,
} from "../src/extensions/registry.ts";
import type { Extension } from "../src/extension/api.ts";
import { writeContact } from "../src/contact.ts";
import type { Generator, GeneratedCandidate, KindCheckInput } from "../src/generators/generator.ts";
import { planStage, stage } from "../src/loop.ts";
import { decodeWav, mediaOf } from "../src/media.ts";
import { DIGITAL_SOURCE_TYPES, readDigitalSourceType } from "../src/metadata.ts";
import { planJobs } from "../src/planning.ts";
import { defaultRoutes } from "../src/routes.ts";
import { tempProject } from "../src/testing/project.ts";
import type { AssetSpec } from "../src/types.ts";
import { scriptedProvider, syntheticWorld } from "./fixtures/synthetic.ts";
import { riffChunkIds, toneWav } from "./fixtures/wav.ts";

const { WaveFile } = wavefile;

const temporary: string[] = [];
const scratch = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-media-trait-")));
  temporary.push(dir);
  return dir;
};
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

const SOUND = toneWav({ channels: 2, sampleRate: 48000, length: 960, bitDepth: "24" });
const seen: KindCheckInput[] = [];

const soundKind = {
  kind: "fx:sound",
  media: "audio",
  planCandidate: () => [],
  checks: [
    {
      name: "fx:sound-format",
      mode: "exact",
      run(input: KindCheckInput) {
        seen.push(input);
        return [
          {
            check: "fx:sound-format",
            passed: input.audio?.layout === "stereo",
            reason: "stereo",
            source: "deterministic",
          },
        ];
      },
    },
  ],
  generate: (): Promise<GeneratedCandidate> =>
    Promise.resolve({
      output: { bytes: SOUND, mediaType: "audio/wav", extension: "wav", fields: {} },
      qa: { passed: true, reasons: [] },
      prompt: "a synthetic tone",
      parameters: {},
    }),
} as unknown as Generator;

const plainKind = { ...soundKind, kind: "fx:plain", media: undefined } as unknown as Generator;

const extension = { api: 3, name: "fx", kinds: [soundKind, plainKind] } as unknown as Extension;
const registry = new ExtensionRegistry([
  CORE_ENTRY,
  { extension, info: { package: "fx-pack", version: "1.0.0", entry: "/x/index.js" } },
]);

test("core's kinds declare their media; a pack kind without one is an image kind", () => {
  assert.equal(mediaOf("still", CORE_REGISTRY), "image");
  assert.equal(mediaOf("sprite-strip", CORE_REGISTRY), "image");
  assert.equal(mediaOf("character-3d", CORE_REGISTRY), "model");
  for (const kind of ["sfx", "ambience", "music"])
    assert.equal(mediaOf(kind, CORE_REGISTRY), "audio");
  assert.equal(mediaOf("fx:sound", registry), "audio");
  assert.equal(mediaOf("fx:plain", registry), "image");
  assert.equal(mediaOf("fx:nothing", registry), undefined);
});

test("a pack kind with an unknown media, or frames on a non-image kind, is refused at load", () => {
  for (const [kind, pattern] of [
    [{ ...soundKind, media: "video" }, /declares media "video"; a kind's media is "image"/],
    [{ ...soundKind, frames: "single" }, /only an image kind has frames/],
  ] as const) {
    const pack = { api: 3, name: "fx", kinds: [kind] };
    assert.throws(
      () => checkExtension(pack, "fx-pack"),
      (e: unknown) => e instanceof ExtensionError && pattern.test(e.message),
    );
  }
});

test("decodeWav gives the PCM per channel from -1 to 1, the sample rate and the channel layout", () => {
  const mono = decodeWav(toneWav({ length: 100 }));
  assert.equal(mono.channelCount, 1);
  assert.equal(mono.layout, "mono");
  assert.equal(mono.sampleRate, 44100);
  assert.equal(mono.bitDepth, "16");
  assert.equal(mono.channels.length, 1);
  assert.equal(mono.channels[0]!.length, 100);
  const stereo = decodeWav(SOUND);
  assert.equal(stereo.layout, "stereo");
  assert.equal(stereo.sampleRate, 48000);
  assert.equal(stereo.bitDepth, "24");
  const raw = new WaveFile(SOUND).getSamples(false, Float64Array) as unknown as Float64Array[];
  for (let c = 0; c < 2; c++) {
    assert.equal(stereo.channels[c]!.length, 960);
    for (let i = 0; i < 960; i += 37)
      assert.ok(Math.abs(stereo.channels[c]![i]! - raw[c]![i]! / 8388607) < 1e-6, `${c}:${i}`);
  }
  assert.ok(Math.max(...stereo.channels[0]!.map(Math.abs)) <= 1);
});

test("stage: an audio kind's checks read the decoded WAV, its candidate carries the AI mark in _PMX and gets a waveform contact cell", async () => {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const spec: AssetSpec = {
    kind: "fx:sound",
    assetId: "chime",
    animationFamily: "idle",
  } as AssetSpec;
  const options = {
    spec,
    specDir: world.dir,
    bible: world.bible,
    bibleDir: world.bibleDir,
    profile: world.profile,
    routes: defaultRoutes,
    provider: scriptedProvider(),
    providerName: "scripted",
    generators: [...registry.kinds] as Generator[],
    runsDir: world.runsDir,
    candidates: 1,
  };
  seen.length = 0;
  planStage(options);
  const { run, runDir } = await stage(options);
  assert.deepEqual(run.errors, []);
  assert.equal(run.candidates.length, 1);
  const audio = seen[0]?.audio;
  assert.ok(audio, "the check context has the decoded audio");
  assert.equal(audio.sampleRate, 48000);
  assert.equal(audio.channelCount, 2);
  assert.equal(audio.layout, "stereo");
  assert.deepEqual(
    audio.channels.map((c) => c.length),
    [960, 960],
  );
  assert.ok(run.candidates[0]!.reasons.some((r) => r.check === "fx:sound-format" && r.passed));

  const candidate = run.candidates[0]!;
  assert.equal(candidate.file, "c1.wav");
  const bytes = new Uint8Array(await readFile(join(runDir, candidate.file)));
  assert.ok(riffChunkIds(bytes).includes("_PMX"));
  assert.equal(readDigitalSourceType(bytes, "audio/wav"), DIGITAL_SOURCE_TYPES.generated);
  assert.deepEqual(decodeWav(bytes).channels, decodeWav(SOUND).channels, "the samples are kept");

  // Its waveform is its contact cell, under the registry or by the trait passed in.
  assert.equal(run.contactSheet, "contact.png");
  assert.equal(
    await writeContact(runDir, spec, run.candidates, [], undefined, registry),
    "contact.png",
  );
});

test("plan and apply refuse a model or audio kind by its media trait", async () => {
  const root = scratch();
  const dir = join(root, ".assetgrove/art-direction");
  await mkdir(dir, { recursive: true });
  await mkdir(join(root, ".assetgrove/prompts"), { recursive: true });
  const data = structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
  data.referenceLicense = "NOASSERTION";
  data.world = "Woodland";
  await writeFile(
    join(dir, "BIBLE.md"),
    serializeBible(
      data,
      "# Rationale\n\n## Do's and Don'ts\nDo keep silhouettes readable. Don't add text.\n",
    ),
  );
  await writeFile(join(root, ".assetgrove/prompts/default.md"), "# Prompt template v1\n{{spec}}\n");
  for (const [kind, media] of [
    ["fx:sound", "an audio"],
    ["character-3d", "a model"],
  ] as const) {
    const specPath = join(root, `${kind.replace(":", "-")}.json`);
    await writeFile(specPath, JSON.stringify({ kind, assetId: "x" }));
    await assert.rejects(
      planJobs({ biblePath: join(dir, "BIBLE.md"), specPath, kinds: registry }),
      new RegExp(`asset kind ${kind} is ${media} kind`),
    );
  }
});

test("vary refuses a candidate of an audio kind by its media trait", async () => {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const options = {
    spec: { kind: "fx:sound", assetId: "chime", animationFamily: "idle" } as AssetSpec,
    specDir: world.dir,
    bible: world.bible,
    bibleDir: world.bibleDir,
    profile: world.profile,
    routes: defaultRoutes,
    provider: scriptedProvider(),
    providerName: "scripted",
    generators: [...registry.kinds] as Generator[],
    runsDir: world.runsDir,
    candidates: 1,
  };
  planStage(options);
  const { runDir } = await stage(options);
  const project = tempProject();
  try {
    const outcome = await project.run(
      "vary",
      { run: runDir, candidate: "c1", dryRun: true },
      { extensions: [extension] },
    );
    assert.notEqual(outcome.exitCode, 0);
    assert.match(JSON.stringify(outcome), /fx:sound candidate, an audio kind; vary edits images/);
  } finally {
    project.close();
  }
});
