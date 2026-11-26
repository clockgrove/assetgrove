import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { decodeAudio, encodeWav, frameCount, sampleHash } from "../src/audio/engine.ts";
import type { AudioItem } from "../src/audio/engine.ts";

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

const workdir = async () => realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-audio-cli-")));

/** A 220 Hz tone at 44100 Hz, 4 s: 0.5 s of silence, 3 s of tone, 0.5 s of silence. */
function toneWav(amp = 0.05): Uint8Array {
  const rate = 44100;
  const c = new Float64Array(4 * rate);
  for (let i = rate / 2; i < 3.5 * rate; i++) c[i] = amp * Math.sin((2 * Math.PI * 220 * i) / rate);
  const item: AudioItem = {
    name: "tone",
    channels: [c],
    sampleRate: rate,
    bitDepth: "16",
    meta: {},
  };
  return encodeWav(item);
}

interface Prov {
  steps: {
    op: string;
    params: Record<string, unknown>;
    inputs: string[];
    outputs: string[];
    engine: { name: string };
  }[];
  sources: { samples: string; mediaType: string }[];
  outputs: { path: string; samples: string; frames: number; meta?: Record<string, unknown> }[];
}

test("recipe runs trim-silence, fade and loop over a WAV with chained sample hashes", async () => {
  const dir = await workdir();
  await writeFile(join(dir, "tone.wav"), toneWav());
  await writeFile(
    join(dir, "recipe.json"),
    JSON.stringify({
      format: "assetgrove-recipe/1",
      steps: [
        { op: "trim-silence", params: { marginMs: 0 } },
        { op: "fade" },
        { op: "loop", params: { seconds: 2, crossfadeMs: 100, curve: "equal-power" } },
      ],
    }),
  );
  const out = join(dir, "out");
  const run = await cli(
    "recipe",
    join(dir, "recipe.json"),
    join(dir, "tone.wav"),
    "--out",
    out,
    "--json",
  );
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const wav = decodeAudio(new Uint8Array(await readFile(join(out, "tone.wav"))));
  assert.equal(frameCount(wav), 88200);
  const prov = JSON.parse(await readFile(join(out, "provenance.json"), "utf8")) as Prov;
  assert.deepEqual(
    prov.steps.map((s) => s.op),
    ["trim-silence", "fade", "loop", "embed-digital-source-type"],
  );
  assert.deepEqual(prov.steps[1]?.params, { inMs: 10, outMs: 10 });
  assert.equal(prov.steps[0]?.engine.name, "assetgrove-audio");
  assert.equal(prov.sources[0]?.mediaType, "audio/wav");
  assert.deepEqual(prov.steps[0]?.inputs, [prov.sources[0]?.samples]);
  assert.deepEqual(prov.steps[1]?.inputs, prov.steps[0]?.outputs);
  assert.deepEqual(prov.steps[2]?.inputs, prov.steps[1]?.outputs);
  assert.deepEqual(prov.steps[2]?.outputs, [prov.outputs[0]?.samples]);
  assert.equal(prov.outputs[0]?.samples, sampleHash(wav));
  assert.equal(prov.outputs[0]?.frames, 88200);
  assert.equal((prov.outputs[0]?.meta?.["loop"] as { lengthFrames: number }).lengthFrames, 88200);
});

test("op gain writes one file with a declared source type", async () => {
  const dir = await workdir();
  await writeFile(join(dir, "tone.wav"), toneWav());
  const out = join(dir, "loud.wav");
  const run = await cli(
    "op",
    "gain",
    join(dir, "tone.wav"),
    "--out",
    out,
    "--params",
    JSON.stringify({ target: -16, truePeakCeiling: -1, encoderHeadroom: 1 }),
    "--json",
  );
  assert.equal(run.code, 0, run.stdout + run.stderr);
  decodeAudio(new Uint8Array(await readFile(out)));
  const prov = JSON.parse(await readFile(`${out}.provenance.json`, "utf8")) as Prov;
  assert.deepEqual(prov.steps[0]?.params, {
    target: -16,
    truePeakCeiling: -1,
    encoderHeadroom: 1,
    measure: "integrated",
  });
  assert.equal(prov.steps.length, 2);
});

test("op loop with --params writes the looped WAV", async () => {
  const dir = await workdir();
  await writeFile(join(dir, "tone.wav"), toneWav());
  const out = join(dir, "loop.wav");
  const run = await cli(
    "op",
    "loop",
    join(dir, "tone.wav"),
    "--out",
    out,
    "--params",
    JSON.stringify({ bars: 1, beatsPerBar: 4, bpm: 130, crossfadeMs: 50, curve: "equal-gain" }),
  );
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.equal(frameCount(decodeAudio(new Uint8Array(await readFile(out)))), 81415);
});

test("a refused gain exits 2 naming both numbers", async () => {
  const dir = await workdir();
  await writeFile(join(dir, "tone.wav"), toneWav(0.9));
  const run = await cli(
    "op",
    "gain",
    join(dir, "tone.wav"),
    "--out",
    join(dir, "x.wav"),
    "--params",
    JSON.stringify({ target: -6, truePeakCeiling: -1, encoderHeadroom: 1 }),
  );
  assert.equal(run.code, 2);
  const text = run.stdout + run.stderr;
  assert.match(text, /true peak at -?\d+\.\d dBTP/);
  assert.match(text, /above -2\.0 dBTP/);
});

test("ops --json lists the audio operations and engine", async () => {
  const run = await cli("ops", "--json");
  assert.equal(run.code, 0);
  const doc = JSON.parse(run.stdout) as {
    data?: Record<string, unknown>;
    engines?: { name: string; encodes: { mediaType: string }[] }[];
    operations?: { name: string; engines: string[] }[];
  };
  const body = (doc.data ?? doc) as typeof doc;
  const names = body.operations!.map((o) => o.name);
  for (const op of ["trim-silence", "fade", "gain", "mono", "resample", "loop"]) {
    assert.ok(names.includes(op), op);
    assert.deepEqual(body.operations!.find((o) => o.name === op)!.engines, ["assetgrove-audio"]);
  }
  const engine = body.engines!.find((e) => e.name === "assetgrove-audio");
  assert.equal(engine?.encodes[0]?.mediaType, "audio/wav");
});
