/**
 * A kind's media trait (docs/PRD-audio.md, core change 1): what its output is, `image`, `model` or
 * `audio`. Core features that need a raster (the contact sheet, the frames trait, plan, apply,
 * vary) and the check context ask the trait of a kind, never its name or its output's media type.
 * A registered kind that declares no trait is an image kind, what core assumed before the trait.
 */
import wavefile from "wavefile";
import type { MediaOutput } from "./types.ts";

const { WaveFile } = wavefile;

/** What a kind's output is. */
export type MediaTrait = "image" | "model" | "audio";

/** The trait values a kind may declare. */
export const MEDIA_TRAITS: readonly MediaTrait[] = ["image", "model", "audio"];

/** The kinds whose media traits a feature reads: a registry, or a list of kinds. */
export interface KindMedia {
  readonly kinds: ReadonlyArray<{ readonly kind: string; readonly media?: MediaTrait }>;
}

/** The kind's media trait: its declared one, else `image`; undefined for a kind not registered. */
export function mediaOf(kind: unknown, traits: KindMedia): MediaTrait | undefined {
  if (typeof kind !== "string") return undefined;
  const found = traits.kinds.find((k) => k.kind === kind);
  return found === undefined ? undefined : (found.media ?? "image");
}

/**
 * What an audio kind's checks read of a candidate: its decoded PCM, one array per channel with
 * samples from −1 to 1, its sample rate and its channel layout.
 */
export interface AudioContext {
  /** One array of samples per channel, each from −1 to 1. */
  channels: Float32Array[];
  sampleRate: number;
  channelCount: number;
  /** `mono`, `stereo`, or `<n> channels`. */
  layout: string;
  /** The file's bit depth as wavefile names it: `8`, `16`, `24`, `32` or `32f`, `64`. */
  bitDepth: string;
}

/** The layout name of a channel count. */
export function channelLayout(count: number): string {
  return count === 1 ? "mono" : count === 2 ? "stereo" : `${count} channels`;
}

/** Decodes a WAV with wavefile; throws when the bytes are not a PCM or float WAV it reads. */
export function decodeWav(bytes: Uint8Array): AudioContext {
  const wav = new WaveFile(bytes);
  // Read before the conversion below, which rebuilds the header.
  const { numChannels, sampleRate } = wav.fmt as { numChannels: number; sampleRate: number };
  const bitDepth = wav.bitDepth;
  // Converted to 32-bit float in this decoded copy, so the samples read −1..1 whatever the file's depth.
  if (bitDepth !== "32f") wav.toBitDepth("32f");
  const samples = wav.getSamples(false, Float32Array) as unknown as Float32Array | Float32Array[];
  const channels = numChannels === 1 ? [samples as Float32Array] : (samples as Float32Array[]);
  return {
    channels,
    sampleRate,
    channelCount: numChannels,
    layout: channelLayout(numChannels),
    bitDepth,
  };
}

/** The check context a kind's media trait adds for one output: an audio kind's decoded WAV. */
export function mediaCheckContext(
  media: MediaTrait | undefined,
  output: MediaOutput,
): { audio?: AudioContext } {
  if (media !== "audio") return {};
  return { audio: decodeWav(output.bytes) };
}
