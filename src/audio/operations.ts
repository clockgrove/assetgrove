/**
 * The audio operations (docs/PRD-audio.md, core change 3): name, parameter schema and the
 * implementations of the `assetgrove-audio` engine. Each is a recipe step that records one
 * provenance step (see `run.ts`). Samples are 64-bit floats from −1 to 1.
 */
import lsr from "@alexanderolsen/libsamplerate-js";
import { InputError } from "../errors.ts";
import type { OperationSpec } from "../transform/types.ts";
import { deriveAudio, frameCount } from "./engine.ts";
import type { AudioItem } from "./engine.ts";
import { integratedLoudness, maxMomentaryLoudness, truePeak } from "./loudness.ts";

/** What an audio operation can read besides its parameters; profile values will arrive here. */
export type AudioOperationContext = Record<string, never>;

export interface AudioOperationResult {
  items: AudioItem[];
  report?: Record<string, unknown>;
}

export type AudioOperationImpl = (
  item: AudioItem,
  params: Record<string, unknown>,
  context: AudioOperationContext,
) => Promise<AudioOperationResult>;

const fixed = (value: number, digits = 1): string => value.toFixed(digits);
const ms = (frames: number, rate: number): number => (frames / rate) * 1000;

export const AUDIO_OPERATIONS: OperationSpec[] = [
  {
    name: "trim-silence",
    summary: "cut leading and trailing silence below a floor, keeping a margin",
    scope: "each",
    media: "audio",
    params: {
      type: "object",
      properties: {
        floorDb: {
          type: "number",
          maximum: 0,
          default: -60,
          description: "samples quieter than this, dBFS, are silence",
        },
        marginMs: {
          type: "number",
          minimum: 0,
          default: 10,
          description: "silence kept before the first and after the last loud sample, ms",
        },
      },
    },
  },
  {
    name: "fade",
    summary: "fade in and out with linear ramps",
    scope: "each",
    media: "audio",
    params: {
      type: "object",
      properties: {
        inMs: { type: "number", minimum: 0, default: 10, description: "fade-in length, ms" },
        outMs: { type: "number", minimum: 0, default: 10, description: "fade-out length, ms" },
      },
    },
  },
  {
    name: "gain",
    summary: "gain to a loudness target; refuses rather than limit the true peak",
    scope: "each",
    media: "audio",
    params: {
      type: "object",
      properties: {
        target: { type: "number", description: "the loudness to reach, LUFS" },
        truePeakCeiling: { type: "number", description: "the true-peak ceiling, dBTP" },
        encoderHeadroom: {
          type: "number",
          minimum: 0,
          description: "dB kept under the ceiling for the encoder",
        },
        measure: {
          type: "string",
          enum: ["integrated", "momentary"],
          default: "integrated",
          description: "integrated loudness, or the maximum momentary loudness for an sfx",
        },
      },
      required: ["target", "truePeakCeiling", "encoderHeadroom"],
    },
  },
  {
    name: "mono",
    summary: "fold the channels to one",
    scope: "each",
    media: "audio",
    params: { type: "object", properties: {} },
  },
  {
    name: "resample",
    summary: "change the sample rate",
    scope: "each",
    media: "audio",
    params: {
      type: "object",
      properties: {
        sampleRate: { type: "integer", minimum: 1000, description: "the new rate, Hz" },
        converter: {
          type: "string",
          enum: ["sinc-best", "sinc-medium", "sinc-fastest"],
          default: "sinc-best",
          description: "the libsamplerate converter",
        },
      },
      required: ["sampleRate"],
    },
  },
  {
    name: "loop",
    summary:
      "cut a file made with an overhang to a loop length and fold the overhang into the head",
    scope: "each",
    media: "audio",
    params: {
      type: "object",
      properties: {
        bars: { type: "number", exclusiveMinimum: 0, description: "bars in the loop (with bpm)" },
        beatsPerBar: { type: "integer", minimum: 1, description: "beats per bar (with bars)" },
        bpm: { type: "number", exclusiveMinimum: 0, description: "tempo, beats per minute" },
        seconds: {
          type: "number",
          exclusiveMinimum: 0,
          description: "the loop length, s, instead of bars, beatsPerBar and bpm",
        },
        crossfadeMs: { type: "number", minimum: 0, description: "crossfade length, ms" },
        curve: {
          type: "string",
          enum: ["equal-gain", "equal-power"],
          description: "equal-gain for music, equal-power for ambience",
        },
      },
      required: ["crossfadeMs", "curve"],
    },
  },
];

function trimSilence(item: AudioItem, params: Record<string, unknown>): AudioOperationResult {
  const floor = 10 ** ((params["floorDb"] as number) / 20);
  const frames = frameCount(item);
  const loud = (i: number) => item.channels.some((c) => Math.abs(c[i]!) >= floor);
  let first = 0;
  while (first < frames && !loud(first)) first++;
  if (first === frames)
    throw new InputError(
      `trim-silence: every frame is below the floor of ${params["floorDb"]} dBFS`,
    );
  let last = frames - 1;
  while (!loud(last)) last--;
  const margin = Math.round(((params["marginMs"] as number) / 1000) * item.sampleRate);
  const start = Math.max(0, first - margin);
  const end = Math.min(frames, last + margin + 1);
  const channels = item.channels.map((c) => c.slice(start, end));
  return {
    items: [deriveAudio(item, channels)],
    report: { headFramesCut: start, tailFramesCut: frames - end },
  };
}

function fade(item: AudioItem, params: Record<string, unknown>): AudioOperationResult {
  const frames = frameCount(item);
  const nIn = Math.round(((params["inMs"] as number) / 1000) * item.sampleRate);
  const nOut = Math.round(((params["outMs"] as number) / 1000) * item.sampleRate);
  if (nIn + nOut > frames)
    throw new InputError(
      `fade: in ${params["inMs"]} ms (${nIn} frames) plus out ${params["outMs"]} ms (${nOut} frames) ` +
        `is longer than the ${frames} frames of the sound`,
    );
  const channels = item.channels.map((c) => {
    const out = c.slice();
    for (let i = 0; i < nIn; i++) out[i]! *= i / nIn;
    for (let j = 0; j < nOut; j++) out[frames - 1 - j]! *= j / nOut;
    return out;
  });
  return {
    items: [deriveAudio(item, channels)],
    report: { fadeInFrames: nIn, fadeOutFrames: nOut },
  };
}

function gain(item: AudioItem, params: Record<string, unknown>): AudioOperationResult {
  const target = params["target"] as number;
  const ceiling = params["truePeakCeiling"] as number;
  const headroom = params["encoderHeadroom"] as number;
  const measure = params["measure"] as string;
  const measured =
    measure === "momentary"
      ? maxMomentaryLoudness(item.channels, item.sampleRate)
      : integratedLoudness(item.channels, item.sampleRate);
  if (measured === null)
    throw new InputError(
      `gain: the ${measure} loudness is undefined (the sound is silent or shorter than 400 ms)`,
    );
  const peak = truePeak(item.channels, item.sampleRate);
  const gainDb = target - measured;
  const after = peak + gainDb;
  const limit = ceiling - headroom;
  if (after > limit)
    throw new InputError(
      `gain: reaching ${fixed(target)} LUFS would put true peak at ${fixed(after)} dBTP, ` +
        `above ${fixed(limit)} dBTP (ceiling ${fixed(ceiling)} dBTP minus ${fixed(headroom)} dB encoder headroom)`,
    );
  const factor = 10 ** (gainDb / 20);
  const channels = item.channels.map((c) => c.map((x) => x * factor));
  return {
    items: [deriveAudio(item, channels)],
    report: {
      measure,
      measuredLufs: measured,
      truePeakBeforeDbtp: peak,
      gainDb,
      truePeakAfterDbtp: after,
      limitDbtp: limit,
    },
  };
}

function mono(item: AudioItem): AudioOperationResult {
  if (item.channels.length === 1)
    return { items: [item], report: { alreadyMono: true, channelsIn: 1 } };
  const count = item.channels.length;
  const out = new Float64Array(frameCount(item));
  for (const c of item.channels) for (let i = 0; i < out.length; i++) out[i]! += c[i]!;
  for (let i = 0; i < out.length; i++) out[i]! /= count;
  return { items: [deriveAudio(item, [out])], report: { channelsIn: count } };
}

const CONVERTERS = {
  "sinc-best": lsr.ConverterType.SRC_SINC_BEST_QUALITY,
  "sinc-medium": lsr.ConverterType.SRC_SINC_MEDIUM_QUALITY,
  "sinc-fastest": lsr.ConverterType.SRC_SINC_FASTEST,
} as const;

async function resample(item: AudioItem, params: Record<string, unknown>) {
  const to = params["sampleRate"] as number;
  const framesIn = frameCount(item);
  if (to === item.sampleRate)
    return { items: [item], report: { from: to, to, framesIn, framesOut: framesIn } };
  const count = item.channels.length;
  const interleaved = new Float32Array(framesIn * count);
  for (let c = 0; c < count; c++)
    for (let i = 0; i < framesIn; i++) interleaved[i * count + c] = item.channels[c]![i]!;
  const src = await lsr.create(count, item.sampleRate, to, {
    converterType: CONVERTERS[params["converter"] as keyof typeof CONVERTERS],
  });
  let result: Float32Array;
  try {
    result = src.simple(interleaved);
  } finally {
    src.destroy();
  }
  const framesOut = Math.floor(result.length / count);
  const channels = item.channels.map((_, c) => {
    const plane = new Float64Array(framesOut);
    for (let i = 0; i < framesOut; i++) plane[i] = result[i * count + c]!;
    return plane;
  });
  return {
    items: [deriveAudio(item, channels, {}, to)],
    report: { from: item.sampleRate, to, framesIn, framesOut },
  };
}

function loop(item: AudioItem, params: Record<string, unknown>): AudioOperationResult {
  const { bars, beatsPerBar, bpm, seconds } = params as Record<string, number | undefined>;
  const tempo = [bars, beatsPerBar, bpm];
  const hasTempo = tempo.some((v) => v !== undefined);
  if (hasTempo === (seconds !== undefined))
    throw new InputError("loop: give either bars, beatsPerBar and bpm, or seconds, not both");
  if (hasTempo && tempo.some((v) => v === undefined))
    throw new InputError("loop: bars, beatsPerBar and bpm are given together");
  const rate = item.sampleRate;
  const exact = hasTempo ? ((bars! * beatsPerBar! * 60) / bpm!) * rate : seconds! * rate;
  const length = Math.floor(exact);
  const residual = exact - length;
  const crossfade = Math.round(((params["crossfadeMs"] as number) / 1000) * rate);
  const frames = frameCount(item);
  const overhang = frames - length;
  if (overhang < 0)
    throw new InputError(
      `loop: the ${frames} frames are shorter than the ${length}-frame loop; generate the loop length plus an overhang`,
    );
  if (overhang < crossfade)
    throw new InputError(
      `loop: the ${frames} frames hold ${overhang} frames (${fixed(ms(overhang, rate), 1)} ms) ` +
        `of overhang past the ${length}-frame loop, shorter than the ${crossfade}-frame (${params["crossfadeMs"]} ms) crossfade`,
    );
  const curve = params["curve"] as string;
  const channels = item.channels.map((c) => {
    const out = c.slice(0, length);
    for (let i = 0; i < crossfade; i++) {
      const t = i / crossfade;
      const fadeIn = curve === "equal-power" ? Math.sin((t * Math.PI) / 2) : t;
      const fadeOut = curve === "equal-power" ? Math.cos((t * Math.PI) / 2) : 1 - t;
      out[i] = c[i]! * fadeIn + c[length + i]! * fadeOut;
    }
    return out;
  });
  const loopMeta = {
    lengthFrames: length,
    exactFrames: exact,
    residual,
    overhangFrames: overhang,
    crossfadeFrames: crossfade,
    curve,
  };
  return { items: [deriveAudio(item, channels, { loop: loopMeta })], report: loopMeta };
}

/** The `assetgrove-audio` engine's implementations, by operation name. */
export const AUDIO_IMPLEMENTATIONS: Record<string, AudioOperationImpl> = {
  "trim-silence": async (item, params) => trimSilence(item, params),
  fade: async (item, params) => fade(item, params),
  gain: async (item, params) => gain(item, params),
  mono: async (item) => mono(item),
  resample: (item, params) => resample(item, params),
  loop: async (item, params) => loop(item, params),
};
