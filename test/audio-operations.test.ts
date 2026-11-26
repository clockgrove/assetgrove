import assert from "node:assert/strict";
import { test } from "node:test";
import { InputError } from "../src/errors.ts";
import { deriveAudio, frameCount, sampleHash } from "../src/audio/engine.ts";
import type { AudioItem } from "../src/audio/engine.ts";
import { integratedLoudness } from "../src/audio/loudness.ts";
import { runAudioOperation, runAudioRecipe } from "../src/audio/run.ts";
import { parseRecipe, runRecipe } from "../src/transform/run.ts";

function item(channels: Float64Array[], sampleRate = 44100): AudioItem {
  return { name: "snd", channels, sampleRate, bitDepth: "32f", meta: {} };
}

function tone(seconds: number, sampleRate = 44100, amp = 0.5, freq = 440): Float64Array {
  const out = new Float64Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++)
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

/** A ramp whose value identifies its frame, for checking folds. */
function ramp(frames: number, sampleRate = 44100): AudioItem {
  const c = new Float64Array(frames);
  for (let i = 0; i < frames; i++) c[i] = Math.sin(i * 0.001) * 0.5 + 0.25;
  return item([c], sampleRate);
}

const recipeOf = (op: string, params: Record<string, unknown> = {}) =>
  parseRecipe({ steps: [{ op, params }] });

test("each audio operation is one recipe step with one provenance step, params resolved", async () => {
  const sound = item([tone(1)]);
  const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["trim-silence", {}, { floorDb: -60, marginMs: 10 }],
    ["fade", {}, { inMs: 10, outMs: 10 }],
    [
      "gain",
      { target: -20, truePeakCeiling: -1, encoderHeadroom: 1 },
      { target: -20, truePeakCeiling: -1, encoderHeadroom: 1, measure: "integrated" },
    ],
    ["mono", {}, {}],
    ["resample", { sampleRate: 22050 }, { sampleRate: 22050, converter: "sinc-best" }],
    [
      "loop",
      { seconds: 0.5, crossfadeMs: 50, curve: "equal-power" },
      { seconds: 0.5, crossfadeMs: 50, curve: "equal-power" },
    ],
  ];
  for (const [op, params, resolved] of cases) {
    const { items, steps } = await runAudioRecipe(recipeOf(op, params), [sound]);
    assert.equal(steps.length, 1, op);
    const step = steps[0]!;
    assert.equal(step.op, op);
    assert.deepEqual(step.params, resolved);
    assert.deepEqual(step.engine, { name: "assetgrove-audio", version: "1.0.0" });
    assert.deepEqual(step.inputs, [sampleHash(sound)]);
    assert.deepEqual(step.outputs, items.map(sampleHash));
  }
});

test("trim-silence cuts head and tail silence and keeps the margin", async () => {
  const rate = 1000;
  const c = new Float64Array(1000);
  for (let i = 300; i < 600; i++) c[i] = 0.5;
  const { items, step } = await runAudioOperation([item([c], rate)], {
    op: "trim-silence",
    params: { marginMs: 20 },
  });
  assert.equal(frameCount(items[0]!), 340);
  assert.equal(items[0]!.channels[0]![0], 0);
  assert.equal(items[0]!.channels[0]![20], 0.5);
  assert.deepEqual(step.report, { headFramesCut: 280, tailFramesCut: 380 });
  await assert.rejects(
    runAudioOperation([item([new Float64Array(100)])], { op: "trim-silence" }),
    (e: Error) => e instanceof InputError && e.message.includes("-60"),
  );
});

test("fade brings the first and last frames to zero", async () => {
  const { items } = await runAudioOperation([item([new Float64Array(1000).fill(1)], 1000)], {
    op: "fade",
    params: { inMs: 100, outMs: 200 },
  });
  const c = items[0]!.channels[0]!;
  assert.equal(c[0], 0);
  assert.equal(c[999], 0);
  assert.equal(c[50], 0.5);
  assert.equal(c[500], 1);
  await assert.rejects(
    runAudioOperation([item([new Float64Array(100).fill(1)], 1000)], {
      op: "fade",
      params: { inMs: 80, outMs: 50 },
    }),
    (e: Error) => e.message.includes("80") && e.message.includes("50"),
  );
});

test("mono averages the channels and passes a mono sound through", async () => {
  const left = new Float64Array([1, 0.5, 0]);
  const right = new Float64Array([0, 0.5, -1]);
  const { items } = await runAudioOperation([item([left, right])], { op: "mono" });
  assert.deepEqual([...items[0]!.channels[0]!], [0.5, 0.5, -0.5]);
  assert.equal(items[0]!.channels.length, 1);
  const again = await runAudioOperation(items, { op: "mono" });
  assert.equal(again.step.report?.["alreadyMono"], true);
  assert.deepEqual(again.step.outputs, again.step.inputs);
});

test("resample 48000 to 44100 changes the rate and the frame count", async () => {
  const sound = item([tone(1, 48000), tone(1, 48000, 0.3)], 48000);
  const { items, step } = await runAudioOperation([sound], {
    op: "resample",
    params: { sampleRate: 44100 },
  });
  assert.equal(items[0]!.sampleRate, 44100);
  assert.equal(items[0]!.channels.length, 2);
  assert.ok(Math.abs(frameCount(items[0]!) - 44100) <= 2);
  assert.equal(step.report?.["from"], 48000);
  assert.equal(step.report?.["framesIn"], 48000);
  const same = await runAudioOperation(items, { op: "resample", params: { sampleRate: 44100 } });
  assert.deepEqual(same.step.outputs, same.step.inputs);
});

test("gain reaches the target and records the gain", async () => {
  const sound = item([tone(4, 44100, 0.05)]);
  const { items, step } = await runAudioOperation([sound], {
    op: "gain",
    params: { target: -16, truePeakCeiling: -1, encoderHeadroom: 1 },
  });
  const after = integratedLoudness(items[0]!.channels, 44100)!;
  assert.ok(Math.abs(after - -16) < 0.1, `loudness ${after}`);
  const report = step.report as Record<string, number>;
  const before = integratedLoudness(sound.channels, 44100)!;
  assert.ok(Math.abs(report["gainDb"]! - (-16 - before)) < 1e-9);
  assert.equal(report["limitDbtp"], -2);
  assert.ok(report["truePeakAfterDbtp"]! <= -2);
});

test("gain refuses when the true peak would pass the limit, naming both numbers", async () => {
  const sound = item([tone(4, 44100, 0.9)]);
  await assert.rejects(
    runAudioOperation([sound], {
      op: "gain",
      params: { target: -2, truePeakCeiling: -1, encoderHeadroom: 1 },
    }),
    (e: Error) =>
      e instanceof InputError &&
      /true peak at -?\d+\.\d dBTP, above -2\.0 dBTP/.test(e.message) &&
      e.message.includes("ceiling -1.0 dBTP minus 1.0 dB encoder headroom"),
  );
  await assert.rejects(
    runAudioOperation([item([new Float64Array(44100)])], {
      op: "gain",
      params: { target: -16, truePeakCeiling: -1, encoderHeadroom: 1 },
    }),
    (e: Error) => e.message.includes("undefined"),
  );
});

test("loop cuts to Godot's length, records the residual and folds the overhang", async () => {
  const params = { bars: 1, beatsPerBar: 4, bpm: 130, crossfadeMs: 100, curve: "equal-gain" };
  const exact = ((1 * 4 * 60) / 130) * 44100;
  const length = Math.floor(exact);
  assert.equal(length, 81415);
  const sound = ramp(length + 8000);
  const { items, step } = await runAudioOperation([sound], { op: "loop", params });
  const out = items[0]!;
  const x = sound.channels[0]!;
  assert.equal(frameCount(out), length);
  const meta = out.meta["loop"] as Record<string, number | string>;
  assert.equal(meta["lengthFrames"], length);
  assert.ok(Math.abs((meta["residual"] as number) - (exact - length)) < 1e-9);
  assert.ok(Math.abs((meta["residual"] as number) - 0.3846) < 1e-3);
  assert.equal(meta["overhangFrames"], 8000);
  assert.equal(meta["crossfadeFrames"], 4410);
  assert.deepEqual(step.report, meta);
  assert.ok(Math.abs(out.channels[0]![0]! - x[length]!) < 1e-12);
  assert.equal(out.channels[0]![4410], x[4410]);
  assert.equal(out.channels[0]![length - 1], x[length - 1]);

  const power = await runAudioOperation([sound], {
    op: "loop",
    params: { ...params, curve: "equal-power" },
  });
  const mid = 2205;
  const gainOut = out.channels[0]![mid]!;
  assert.ok(Math.abs(gainOut - (x[mid]! * 0.5 + x[length + mid]! * 0.5)) < 1e-12);
  const c = Math.SQRT1_2;
  assert.ok(
    Math.abs(power.items[0]!.channels[0]![mid]! - (x[mid]! * c + x[length + mid]! * c)) < 1e-12,
  );
  assert.notEqual(power.items[0]!.channels[0]![mid], gainOut);
});

test("loop with whole-sample length: 120 bpm, 4/4, 2 bars at 44100 is 176400 frames", async () => {
  const { items } = await runAudioOperation([ramp(176400 + 1000)], {
    op: "loop",
    params: { bars: 2, beatsPerBar: 4, bpm: 120, crossfadeMs: 10, curve: "equal-gain" },
  });
  assert.equal(frameCount(items[0]!), 176400);
  assert.equal(items[0]!.meta["loop"] !== undefined, true);
});

test("loop refuses a short overhang and an ambiguous or incomplete length", async () => {
  const base = { crossfadeMs: 100, curve: "equal-gain" };
  await assert.rejects(
    runAudioOperation([ramp(44100 + 1000)], { op: "loop", params: { seconds: 1, ...base } }),
    (e: Error) =>
      e instanceof InputError &&
      e.message.includes("1000 frames") &&
      e.message.includes("4410-frame"),
  );
  await assert.rejects(
    runAudioOperation([ramp(40000)], { op: "loop", params: { seconds: 1, ...base } }),
    (e: Error) =>
      e instanceof InputError && e.message.includes("shorter than the 44100-frame loop"),
  );
  await assert.rejects(
    runAudioOperation([ramp(100000)], {
      op: "loop",
      params: { seconds: 1, bars: 1, beatsPerBar: 4, bpm: 120, ...base },
    }),
    (e: Error) => e instanceof InputError && e.message.includes("not both"),
  );
  await assert.rejects(
    runAudioOperation([ramp(100000)], { op: "loop", params: { bars: 1, bpm: 120, ...base } }),
    (e: Error) => e instanceof InputError && e.message.includes("together"),
  );
  await assert.rejects(
    runAudioOperation([ramp(100000)], { op: "loop", params: base }),
    (e: Error) => e instanceof InputError,
  );
});

test("media mismatches are refused naming the operation", async () => {
  await assert.rejects(
    runAudioOperation([ramp(100)], { op: "trim" }),
    (e: Error) =>
      e instanceof InputError && e.message.includes("trim") && e.message.includes("audio"),
  );
  assert.throws(
    () => runRecipe(recipeOf("mono"), []),
    (e: Error) =>
      e instanceof InputError && e.message.includes("mono") && e.message.includes("images"),
  );
  assert.throws(() => parseRecipe({ steps: [{ op: "fade", params: { inMs: -1 } }] }), InputError);
  assert.equal(deriveAudio(ramp(10), [new Float64Array(1)]).channels.length, 1);
});
