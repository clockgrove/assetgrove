import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUDIO_CHECKS,
  SET_LOUDNESS_CHECK,
  loopFrames,
  memberLoudness,
  setLoudness,
} from "../src/audio/checks.ts";
import { decodeAudio, encodeWav, sampleHash } from "../src/audio/engine.ts";
import type { AudioItem } from "../src/audio/engine.ts";
import { measureLoudness } from "../src/audio/loudness.ts";
import type { KindCheckInput } from "../src/generators/generator.ts";
import type { TransformStep } from "../src/transform/types.ts";
import type { AssetSpec, Reason, TargetProfile } from "../src/types.ts";

const RATE = 8000;

function sine(seconds: number, amp: number, rate = RATE, phase = 0): Float64Array {
  const out = new Float64Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++)
    out[i] = amp * Math.sin((2 * Math.PI * 440 * i) / rate + phase);
  return out;
}

function wav(channels: Float64Array[], bitDepth = "16", sampleRate = RATE): Uint8Array {
  const item: AudioItem = { name: "snd", channels, sampleRate, bitDepth, meta: {} };
  return encodeWav(item);
}

function profile(audio: Record<string, unknown> = {}): TargetProfile {
  return {
    name: "test",
    license: "MIT",
    audio: {
      sampleRate: RATE,
      loudness: { target: -23, tolerance: 1, truePeakCeiling: -1, encoderHeadroom: 0 },
      ...audio,
    },
  } as unknown as TargetProfile;
}

/** The amplitude of a 440 Hz mono-in-both-channels sine that measures about `lufs` integrated. */
function ampFor(lufs: number, seconds = 1.5): number {
  const probe = sine(seconds, 0.1);
  const measured = measureLoudness([probe, probe], RATE).integrated!;
  return 0.1 * 10 ** ((lufs - measured) / 20);
}

function stereoAt(lufs: number, seconds = 1.5): Float64Array[] {
  const a = ampFor(lufs, seconds);
  return [sine(seconds, a), sine(seconds, a, RATE, 1)];
}

function run(
  name: string,
  spec: Record<string, unknown>,
  bytes: Uint8Array,
  options: { profile?: TargetProfile; steps?: TransformStep[] } = {},
): Reason {
  const check = AUDIO_CHECKS.find((c) => c.name === name)!;
  const input = {
    spec: { assetId: "a", brief: "b", ...spec } as unknown as AssetSpec,
    profile: options.profile ?? profile(),
    bible: {},
    output: {
      mediaType: "audio/wav",
      extension: "wav",
      bytes,
      fields: options.steps === undefined ? {} : { audio: { steps: options.steps } },
    },
  } as unknown as KindCheckInput;
  const reasons = check.run!(input, undefined as never) as Reason[];
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0]!.check, name);
  assert.equal(reasons[0]!.source, "deterministic");
  return reasons[0]!;
}

function step(op: string, input: string, output: string): TransformStep {
  return {
    op,
    params: {},
    engine: { name: "assetgrove-audio", version: "1" },
    inputs: [input],
    outputs: [output],
  };
}

test("every audio check is exact and deterministic", () => {
  assert.deepEqual(
    AUDIO_CHECKS.map((c) => c.name),
    [
      "audio:format",
      "audio:duration",
      "audio:true-peak",
      "audio:loudness",
      "audio:silence",
      "audio:fade",
      "audio:loop",
      "audio:fake-stereo",
    ],
  );
  for (const c of AUDIO_CHECKS) {
    assert.equal(c.mode, "exact");
    assert.equal(c.source, "deterministic");
  }
  assert.equal(SET_LOUDNESS_CHECK, "audio:set-loudness");
});

test("audio:format: the profile's rate, layout and depth", () => {
  const stereo = wav(stereoAt(-23));
  assert.equal(run("audio:format", { kind: "music" }, stereo).passed, true);
  const rate = run("audio:format", { kind: "music" }, wav(stereoAt(-23), "16", 4000));
  assert.equal(rate.passed, false);
  assert.match(rate.reason, /4000 Hz/);
  const mono = run("audio:format", { kind: "music" }, wav([sine(1, 0.1)]));
  assert.equal(mono.passed, false);
  assert.match(mono.reason, /1 channels, profile 2/);
  const depth = run("audio:format", { kind: "music" }, wav(stereoAt(-23), "24"));
  assert.equal(depth.passed, false);
  assert.match(depth.reason, /bit depth 24/);
  assert.equal(run("audio:format", { kind: "sfx" }, wav([sine(1, 0.1)])).passed, true);
});

test("loopFrames matches the loop operation's formula", () => {
  assert.deepEqual(loopFrames({ kind: "ambience", loopS: 2.5 }, 44100), {
    frames: 110250,
    residual: 0,
  });
  const odd = loopFrames({ kind: "ambience", loopS: 1.00001 }, 44100)!;
  assert.equal(odd.frames, 44100);
  assert.ok(Math.abs(odd.residual - 0.441) < 1e-6);
  // 7 bars of 4 at 150 bpm and 44100 Hz is a whole 493920 frames.
  assert.deepEqual(
    loopFrames(
      { kind: "music", form: "track", loop: { bpm: 150, bars: 7, beatsPerBar: 4 } },
      44100,
    ),
    { frames: 493920, residual: 0 },
  );
  assert.equal(loopFrames({ kind: "sfx", maxDurationS: 2 }, 44100), undefined);
  assert.equal(loopFrames({ kind: "music", form: "cue", durationS: 4 }, 44100), undefined);
});

test("audio:duration: sfx limit, exact loop length, track tolerance", () => {
  const one = wav([sine(1, 0.1)]);
  assert.equal(run("audio:duration", { kind: "sfx", maxDurationS: 1 }, one).passed, true);
  const long = run("audio:duration", { kind: "sfx", maxDurationS: 0.5 }, one);
  assert.equal(long.passed, false);
  assert.match(long.reason, /1\.00 s, limit 0\.50 s/);

  const loop = wav(stereoAt(-23, 1));
  assert.equal(run("audio:duration", { kind: "ambience", loopS: 1 }, loop).passed, true);
  const off = run("audio:duration", { kind: "ambience", loopS: 1.001 }, loop);
  assert.equal(off.passed, false);
  assert.match(off.reason, /8000 frames, the loop is 8008 frames/);
  const music = { kind: "music", form: "track", loop: { bpm: 120, bars: 1, beatsPerBar: 4 } };
  assert.equal(run("audio:duration", music, wav(stereoAt(-23, 2))).passed, true);
  assert.match(
    run("audio:duration", music, wav(stereoAt(-23, 1.5))).reason,
    /12000 frames, the loop is 16000/,
  );

  const track = wav(stereoAt(-23, 1.5));
  assert.equal(
    run("audio:duration", { kind: "music", form: "cue", durationS: 1.8 }, track).passed,
    true,
  );
  const wrong = run("audio:duration", { kind: "music", form: "track", durationS: 2.5 }, track, {
    profile: profile({ durationToleranceS: 0.5 }),
  });
  assert.equal(wrong.passed, false);
  assert.match(wrong.reason, /1\.50 s, 2\.50 s ± 0\.50 s/);
});

test("audio:true-peak: ceiling less encoder headroom", () => {
  const quiet = wav([sine(0.5, 0.5)]);
  assert.equal(run("audio:true-peak", { kind: "sfx" }, quiet).passed, true);
  const hot = run("audio:true-peak", { kind: "sfx" }, wav([sine(0.5, 0.99)]));
  assert.equal(hot.passed, false);
  assert.match(hot.reason, /limit -1\.00 dBTP/);
  const headroom = run("audio:true-peak", { kind: "sfx" }, wav([sine(0.5, 0.6)]), {
    profile: profile({
      loudness: { target: -23, tolerance: 1, truePeakCeiling: -1, encoderHeadroom: 5 },
    }),
  });
  assert.equal(headroom.passed, false);
  assert.match(headroom.reason, /limit -6\.00 dBTP/);
});

test("audio:loudness: integrated for loops, momentary for sfx, short sfx by true peak", () => {
  const ok = wav(stereoAt(-23));
  assert.equal(run("audio:loudness", { kind: "ambience" }, ok).passed, true);
  const loud = run("audio:loudness", { kind: "music" }, wav(stereoAt(-18)));
  assert.equal(loud.passed, false);
  assert.match(loud.reason, /integrated loudness is -18\.\d\d LUFS, target -23\.00 ± 1\.00/);

  const sfx = wav([sine(1, ampFor(-23) * 1.0)]);
  const sfxMeasured = measureLoudness([sine(1, ampFor(-23))], RATE).momentaryMax!;
  const sfxProfile = profile({
    loudness: { target: sfxMeasured, tolerance: 0.5, truePeakCeiling: -1, encoderHeadroom: 0 },
  });
  assert.equal(run("audio:loudness", { kind: "sfx" }, sfx, { profile: sfxProfile }).passed, true);
  const sfxOff = run("audio:loudness", { kind: "sfx" }, sfx);
  assert.equal(sfxOff.passed, sfxMeasured >= -24 && sfxMeasured <= -22);
  const farProfile = profile({
    loudness: { target: sfxMeasured + 6, tolerance: 0.5, truePeakCeiling: -1, encoderHeadroom: 0 },
  });
  const far = run("audio:loudness", { kind: "sfx" }, sfx, { profile: farProfile });
  assert.equal(far.passed, false);
  assert.match(far.reason, /maximum momentary loudness is/);

  const short = run("audio:loudness", { kind: "sfx" }, wav([sine(0.2, 0.5)]));
  assert.equal(short.passed, true);
  assert.match(short.reason, /400 ms.*true peak alone/);
  const shortHot = run("audio:loudness", { kind: "sfx" }, wav([sine(0.2, 0.99)]));
  assert.equal(shortHot.passed, false);

  const silent = run(
    "audio:loudness",
    { kind: "ambience" },
    wav([new Float64Array(12000), new Float64Array(12000)]),
  );
  assert.equal(silent.passed, false);
  assert.match(silent.reason, /undefined/);
});

function padded(lead: number, body: number, trail: number): Uint8Array {
  const out = new Float64Array(lead + body + trail);
  out.set(sine(body / RATE, 0.5), lead);
  return wav([out]);
}

test("audio:silence: leading and trailing silence of an sfx", () => {
  // 50 ms at 8 kHz is 400 frames.
  assert.equal(run("audio:silence", { kind: "sfx" }, padded(200, 4000, 200)).passed, true);
  const lead = run("audio:silence", { kind: "sfx" }, padded(800, 4000, 0));
  assert.equal(lead.passed, false);
  assert.match(
    lead.reason,
    /leading silence 100\.\d\d ms, trailing silence 0\.00 ms, limit 50\.00/,
  );
  const trail = run("audio:silence", { kind: "sfx" }, padded(0, 4000, 1600));
  assert.equal(trail.passed, false);
  assert.match(trail.reason, /trailing silence 200\.00 ms/);
  const quietLead = new Float64Array(3500);
  quietLead.set(sine(0.4, 0.5), 300);
  // 0.0005 is below -60 dBFS: still silence.
  quietLead.fill(0.0005, 0, 300);
  assert.equal(run("audio:silence", { kind: "sfx" }, wav([quietLead])).passed, true);
  const silent = run("audio:silence", { kind: "sfx" }, wav([new Float64Array(8000)]));
  assert.equal(silent.passed, false);
  assert.match(silent.reason, /silent throughout/);
  assert.match(
    run("audio:silence", { kind: "music" }, wav(stereoAt(-23))).reason,
    /does not apply/,
  );
});

test("audio:fade: an sfx's recipe has a fade step chained to the master", () => {
  const bytes = wav([sine(1, 0.5)]);
  const master = sampleHash(decodeAudio(bytes));
  const steps = [step("trim-silence", "src", "mid"), step("fade", "mid", master)];
  assert.equal(run("audio:fade", { kind: "sfx" }, bytes, { steps }).passed, true);
  const missing = run("audio:fade", { kind: "sfx" }, bytes, {
    steps: [step("gain", "src", master)],
  });
  assert.equal(missing.passed, false);
  assert.match(missing.reason, /no fade step/);
  const broken = run("audio:fade", { kind: "sfx" }, bytes, {
    steps: [step("fade", "src", "mid"), step("gain", "mid", "other")],
  });
  assert.equal(broken.passed, false);
  assert.match(broken.reason, /do not chain to the master/);
  const gap = run("audio:fade", { kind: "sfx" }, bytes, {
    steps: [step("fade", "src", "mid"), step("gain", "nope", master)],
  });
  assert.equal(gap.passed, false);
  assert.match(run("audio:fade", { kind: "ambience" }, bytes, { steps }).reason, /does not apply/);
});

test("audio:loop: a loop step leads to the master", () => {
  const bytes = wav(stereoAt(-23, 1));
  const master = sampleHash(decodeAudio(bytes));
  const spec = { kind: "ambience", loopS: 1 };
  const steps = [step("loop", "src", "mid"), step("gain", "mid", master)];
  assert.equal(run("audio:loop", spec, bytes, { steps }).passed, true);
  const none = run("audio:loop", spec, bytes, { steps: [step("gain", "src", master)] });
  assert.equal(none.passed, false);
  assert.match(none.reason, /no loop step/);
  const after = run("audio:loop", spec, bytes, {
    steps: [step("loop", "src", "mid"), step("gain", "mid", "x")],
  });
  assert.equal(after.passed, false);
  assert.match(after.reason, /do not lead to the master/);
  const cue = { kind: "music", form: "cue", durationS: 1 };
  assert.match(run("audio:loop", cue, bytes, { steps: [] }).reason, /does not apply/);
  const track = { kind: "music", form: "track", loop: { bpm: 120, bars: 1, beatsPerBar: 2 } };
  assert.equal(run("audio:loop", track, bytes, { steps }).passed, true);
});

test("audio:fake-stereo: identical channels fail and name the mono step", () => {
  const tone = sine(1, 0.3);
  const fake = run("audio:fake-stereo", { kind: "music" }, wav([tone, tone.slice()]));
  assert.equal(fake.passed, false);
  assert.match(fake.reason, /all 2 channels are identical.*mono recipe step/);
  assert.equal(run("audio:fake-stereo", { kind: "music" }, wav(stereoAt(-23))).passed, true);
  assert.equal(run("audio:fake-stereo", { kind: "sfx" }, wav([tone])).passed, true);
});

test("audio:set-loudness: members within the spread of the median", () => {
  const reasons = setLoudness(
    [
      { id: "a", loudness: -23 },
      { id: "b", loudness: -22.5 },
      { id: "c", loudness: -23.5 },
      { id: "d", loudness: -18 },
      { id: "e", loudness: null },
    ],
    2,
  );
  assert.deepEqual(
    reasons.map((r) => r.passed),
    [true, true, true, false, false],
  );
  assert.ok(reasons.every((r) => r.check === SET_LOUDNESS_CHECK && r.source === "deterministic"));
  assert.match(
    reasons[3]!.reason,
    /d is -18\.00 LUFS, 4\.75 LU from the set median -22\.75 LUFS \(limit 2\.00 LU\)/,
  );
  assert.match(reasons[4]!.reason, /no defined loudness/);
});

test("memberLoudness: momentary for sfx, integrated otherwise", () => {
  const channels = [sine(1, 0.3, RATE)].map((c) => Float32Array.from(c));
  const audio = { channels, sampleRate: RATE, channelCount: 1, layout: "mono", bitDepth: "16" };
  const measure = measureLoudness(channels, RATE);
  assert.equal(memberLoudness("sfx", audio), measure.momentaryMax);
  assert.equal(memberLoudness("music", audio), measure.integrated);
});
