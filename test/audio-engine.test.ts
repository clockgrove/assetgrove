/**
 * The audio engine (src/audio/engine.ts): WAV round trips at every bit depth, a sample hash that
 * ignores other chunks and sees every sample, rate and depth, integer rounding and clamping, and
 * the refusal of bytes that are not a WAV. All inputs are synthetic.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import wavefile from "wavefile";
import {
  AUDIO_BIT_DEPTHS,
  decodeAudio,
  encodeWav,
  pcmBytes,
  sampleHash,
  type AudioItem,
} from "../src/audio/engine.ts";
import { InputError } from "../src/errors.ts";
import { DIGITAL_SOURCE_TYPES, embedDigitalSourceType } from "../src/metadata.ts";

const { WaveFile } = wavefile;

function item(channelCount: number, bitDepth: string, sampleRate = 44100): AudioItem {
  const channels = Array.from({ length: channelCount }, (_, c) =>
    Float64Array.from(
      { length: 480 },
      (_, i) => 0.8 * Math.sin((2 * Math.PI * (220 + 110 * c) * i) / sampleRate) + 0.001 * (i % 7),
    ),
  );
  return { name: "tone", channels, sampleRate, bitDepth, meta: {} };
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

for (const bitDepth of AUDIO_BIT_DEPTHS) {
  for (const channelCount of [1, 2]) {
    test(`round trip at ${bitDepth} bit, ${channelCount} channel(s)`, () => {
      const original = item(channelCount, bitDepth);
      const decoded = decodeAudio(encodeWav(original));
      assert.equal(decoded.channels.length, channelCount);
      assert.equal(decoded.sampleRate, original.sampleRate);
      assert.equal(decoded.bitDepth, bitDepth);
      assert.equal(decoded.channels[0]!.length, original.channels[0]!.length);
      assert.deepEqual(pcmBytes(decoded), pcmBytes(original));
      assert.equal(sampleHash(decoded), sampleHash(original));
    });
  }
}

test("the same samples in files with different chunks hash the same", () => {
  const original = item(2, "16");
  const plain = encodeWav(original);

  // wavefile cannot read back a file it wrote with both a LIST and a cue chunk, so each is its own file.
  const tagged = new WaveFile(plain);
  tagged.setTag("ICMT", "x");
  const cued = new WaveFile(plain);
  cued.setCuePoint({ position: 100, label: "x" });

  const marked = embedDigitalSourceType(plain, "audio/wav", DIGITAL_SOURCE_TYPES.generated);

  for (const other of [tagged.toBuffer(), cued.toBuffer(), marked]) {
    assert.notEqual(sha(other), sha(plain));
    assert.ok(other.length > plain.length);
    assert.equal(sampleHash(decodeAudio(other)), sampleHash(decodeAudio(plain)));
  }
});

test("different samples, rates and depths hash differently", () => {
  const base = item(2, "16");
  const baseHash = sampleHash(base);

  const nudged = item(2, "16");
  nudged.channels[1]![100] = nudged.channels[1]![100]! + 1 / 32768;
  assert.notEqual(sampleHash(nudged), baseHash);

  assert.notEqual(sampleHash({ ...base, sampleRate: 48000 }), baseHash);

  const wider: AudioItem = { ...base, bitDepth: "24" };
  assert.notEqual(sampleHash(wider), baseHash);
});

test("integer depths round and clamp", () => {
  for (const [bitDepth, scale] of [
    ["8", 128],
    ["16", 32768],
    ["24", 8388608],
    ["32", 2147483648],
  ] as const) {
    const over: AudioItem = {
      name: "clip",
      channels: [Float64Array.from([1.5, -1.5, 0])],
      sampleRate: 8000,
      bitDepth,
      meta: {},
    };
    const [high, low, zero] = decodeAudio(encodeWav(over)).channels[0]!;
    assert.equal(high, (scale - 1) / scale, `${bitDepth} bit maximum`);
    assert.equal(low, -1, `${bitDepth} bit minimum`);
    assert.equal(zero, 0, `${bitDepth} bit zero`);
  }
  const rounded: AudioItem = {
    name: "round",
    channels: [Float64Array.from([2.4 / 32768, 2.6 / 32768, -2.6 / 32768])],
    sampleRate: 8000,
    bitDepth: "16",
    meta: {},
  };
  assert.deepEqual(
    Array.from(decodeAudio(encodeWav(rounded)).channels[0]!, (v) => v * 32768),
    [2, 3, -3],
  );
});

test("decodeAudio refuses bytes that are not a WAV", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const noise = Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256);
  for (const bytes of [png, noise]) {
    assert.throws(
      () => decodeAudio(bytes),
      (error) => error instanceof InputError && /not a WAV/.test(error.message),
    );
  }
});
