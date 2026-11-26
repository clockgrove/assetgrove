/**
 * The audio engine of the transform core (docs/PRD-audio.md, core change 2), beside the raster
 * engine: it decodes and writes PCM WAV through `wavefile` and gives an exact sample hash. Samples
 * are held as 64-bit floats from −1 to 1, scaled from the file's integers by a power of two, so a
 * decoded file written back at its own bit depth has the same samples to the bit.
 */
import { createHash } from "node:crypto";
import wavefile from "wavefile";
import { InputError } from "../errors.ts";
import type { DigitalSourceType } from "../metadata.ts";

const { WaveFile } = wavefile;

/** The engine's name and version, recorded on every step it runs and every file it writes. */
export const AUDIO_ENGINE = { name: "assetgrove-audio", version: "1.0.0" } as const;

/** The bit depths the engine reads and writes, as wavefile names them. */
export const AUDIO_BIT_DEPTHS = ["8", "16", "24", "32", "32f", "64"] as const;

/** One sound flowing through a recipe. */
export interface AudioItem {
  digitalSourceType?: DigitalSourceType;
  /** Names the output file: the source's base name. */
  name: string;
  /** One array of samples per channel, each from −1 to 1; all of one length. */
  channels: Float64Array[];
  sampleRate: number;
  /** The bit depth the item is written at, as wavefile names it: `8`, `16`, `24`, `32`, `32f` or `64`. */
  bitDepth: string;
  /** What operations measured or decided for this item (JSON values), for callers and reports. */
  meta: Record<string, unknown>;
}

/** The number of sample frames (samples per channel) of an item. */
export function frameCount(item: Pick<AudioItem, "channels">): number {
  return item.channels[0]?.length ?? 0;
}

const FLOAT_DEPTHS = new Set(["32f", "64"]);
/** WAVE_FORMAT_PCM, WAVE_FORMAT_IEEE_FLOAT and WAVE_FORMAT_EXTENSIBLE. */
const PCM_FORMATS = new Set([1, 3, 0xfffe]);

/** The scale of an integer depth: a sample of value `v` is `v / scale`. */
function scaleOf(bitDepth: string): number {
  return 2 ** (Number.parseInt(bitDepth, 10) - 1);
}

/**
 * Decodes a PCM or IEEE-float WAV. Throws an InputError when the bytes are not a WAV, or are a
 * compressed or unsupported one.
 */
export function decodeAudio(bytes: Uint8Array, name = "audio"): AudioItem {
  let wav: InstanceType<typeof WaveFile>;
  try {
    wav = new WaveFile(bytes);
  } catch (error) {
    throw new InputError(`not a WAV file: ${(error as Error).message}`, { cause: error });
  }
  const fmt = wav.fmt as { numChannels: number; sampleRate: number; audioFormat: number };
  const bitDepth = wav.bitDepth;
  if (
    !PCM_FORMATS.has(fmt.audioFormat) ||
    !(AUDIO_BIT_DEPTHS as readonly string[]).includes(bitDepth)
  ) {
    throw new InputError(
      `unsupported WAV: format ${fmt.audioFormat}, bit depth ${bitDepth}; ` +
        `the audio engine reads PCM at ${AUDIO_BIT_DEPTHS.join(", ")} bits`,
    );
  }
  if (fmt.numChannels < 1 || fmt.sampleRate < 1) throw new InputError("WAV has no channels");
  const raw = wav.getSamples(false, Float64Array) as unknown as Float64Array | Float64Array[];
  const planes = fmt.numChannels === 1 ? [raw as Float64Array] : (raw as Float64Array[]);
  const channels = planes.map((plane) => {
    const out = new Float64Array(plane.length);
    if (FLOAT_DEPTHS.has(bitDepth)) out.set(plane);
    else if (bitDepth === "8")
      for (let i = 0; i < plane.length; i++) out[i] = (plane[i]! - 128) / 128;
    else {
      const scale = scaleOf(bitDepth);
      for (let i = 0; i < plane.length; i++) out[i] = plane[i]! / scale;
    }
    return out;
  });
  return { name, channels, sampleRate: fmt.sampleRate, bitDepth, meta: {} };
}

/**
 * The item's samples interleaved as the file's data chunk holds them: little-endian, at its bit
 * depth. Integer depths round to the nearest step and clamp to the range.
 */
export function pcmBytes(item: AudioItem): Uint8Array {
  return (toWave(item).data as { samples: Uint8Array }).samples;
}

function toWave(item: AudioItem): InstanceType<typeof WaveFile> {
  if (!(AUDIO_BIT_DEPTHS as readonly string[]).includes(item.bitDepth))
    throw new InputError(`unsupported bit depth ${item.bitDepth}`);
  const count = item.channels.length;
  const frames = frameCount(item);
  if (count < 1) throw new InputError("audio has no channels");
  const float = FLOAT_DEPTHS.has(item.bitDepth);
  const interleaved = new Float64Array(frames * count);
  const scale = float ? 1 : scaleOf(item.bitDepth);
  const lo = -scale;
  const hi = scale - 1;
  for (let c = 0; c < count; c++) {
    const plane = item.channels[c]!;
    if (plane.length !== frames) throw new Error("audio channels differ in length");
    for (let i = 0; i < frames; i++) {
      const x = plane[i]!;
      let v: number;
      if (float) v = item.bitDepth === "32f" ? Math.fround(x) : x;
      else {
        v = Math.min(hi, Math.max(lo, Math.round(x * scale)));
        if (item.bitDepth === "8") v += 128;
      }
      interleaved[i * count + c] = v;
    }
  }
  const wav = new WaveFile();
  wav.fromScratch(count, item.sampleRate, item.bitDepth, interleaved);
  return wav;
}

/** Writes the item as a WAV holding only its `fmt ` and `data` chunks. */
export function encodeWav(item: AudioItem): Uint8Array {
  return toWave(item).toBuffer();
}

/**
 * SHA-256 over `pcm <bitDepth> <channels>x<sampleRate>\n` and the samples as `pcmBytes` gives
 * them: a hash of the sound, not of the file, so other chunks (marks, loop points, credentials)
 * never change it.
 */
export function sampleHash(item: AudioItem): string {
  return createHash("sha256")
    .update(`pcm ${item.bitDepth} ${item.channels.length}x${item.sampleRate}\n`)
    .update(pcmBytes(item))
    .digest("hex");
}

/** A new item from `item` with new samples (and optionally a new rate); meta is merged. */
export function deriveAudio(
  item: AudioItem,
  channels: Float64Array[],
  meta: Record<string, unknown> = {},
  sampleRate = item.sampleRate,
): AudioItem {
  return { ...item, channels, sampleRate, meta: { ...item.meta, ...meta } };
}
