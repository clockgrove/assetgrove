/**
 * Loudness and true peak (docs/PRD-audio.md, "Loudness"), from the `@audio/loudness` family:
 * integrated loudness from `@audio/loudness-lufs` (ITU-R BS.1770-4, gated), true peak from
 * `@audio/loudness-truepeak` (4× oversampled, BS.1770 Annex 2), and maximum momentary loudness, the
 * loudest ungated 400 ms block, over the same K-weighting (`@audio/weighting-k`) and channel
 * weights `@audio/loudness-lufs` uses. All three are proven on the EBU Tech 3341 vectors
 * (test/audio-loudness.test.ts).
 */
import lufs, { LAYOUTS } from "@audio/loudness-lufs";
import truepeak from "@audio/loudness-truepeak";
import kWeighting from "@audio/weighting-k";

/** BS.1770's loudness offset, LUFS = −0.691 + 10·log10(Σ G·z). */
const OFFSET = -0.691;
/** Momentary loudness's window, s, and the hop between windows, s (BS.1770 blocks, 75% overlap). */
const WINDOW = 0.4;
const HOP = 0.1;

type Channels = ArrayLike<number>[];

function asFloat32(channels: Channels): Float32Array[] {
  return channels.map((c) => (c instanceof Float32Array ? c : Float32Array.from(c)));
}

function weightsOf(count: number): readonly number[] {
  return LAYOUTS[count] ?? Array.from({ length: count }, () => 1);
}

/** Integrated loudness, LUFS; null for silence or a clip shorter than one 400 ms block. */
export function integratedLoudness(channels: Channels, sampleRate: number): number | null {
  return lufs(asFloat32(channels), { fs: sampleRate });
}

/** True peak, dBTP; −Infinity for silence. */
export function truePeak(channels: Channels, sampleRate: number): number {
  return truepeak(asFloat32(channels), { fs: sampleRate });
}

/**
 * Maximum momentary loudness, LUFS: the loudest 400 ms window, windows 100 ms apart from the
 * start; null for a clip shorter than 400 ms or silence.
 */
export function maxMomentaryLoudness(channels: Channels, sampleRate: number): number | null {
  const hop = Math.round(HOP * sampleRate);
  const per = Math.round(WINDOW / HOP);
  const frames = channels[0]?.length ?? 0;
  const hops = Math.floor(frames / hop);
  if (hops < per) return null;
  const weights = weightsOf(channels.length);
  // Per hop, the K-weighted mean square of each channel, with the filter state carried across hops.
  const blocks = channels.map((c) => (c instanceof Float64Array ? c : Float64Array.from(c)));
  const params: { fs: number; states?: Float64Array[] } = { fs: sampleRate };
  const power = new Float64Array(hops);
  const ms = new Float64Array(channels.length);
  for (let h = 0; h < hops; h++) {
    const slices = blocks.map((c) => c.subarray(h * hop, (h + 1) * hop));
    kWeighting.ms(slices, params, ms);
    let z = 0;
    for (let c = 0; c < channels.length; c++) z += weights[c]! * ms[c]!;
    power[h] = z;
  }
  let max = 0;
  for (let b = 0; b + per <= hops; b++) {
    let z = 0;
    for (let p = 0; p < per; p++) z += power[b + p]!;
    max = Math.max(max, z / per);
  }
  return max > 0 ? OFFSET + 10 * Math.log10(max) : null;
}

/** The loudness figures of a sound, as checks and the `gain` step read them. */
export interface LoudnessMeasure {
  /** Integrated loudness, LUFS; null when undefined (silence, or under 400 ms). */
  integrated: number | null;
  /** Maximum momentary loudness, LUFS; null when undefined (silence, or under 400 ms). */
  momentaryMax: number | null;
  /** True peak, dBTP; −Infinity for silence. */
  truePeak: number;
}

/** Integrated loudness, maximum momentary loudness and true peak of a sound. */
export function measureLoudness(channels: Channels, sampleRate: number): LoudnessMeasure {
  return {
    integrated: integratedLoudness(channels, sampleRate),
    momentaryMax: maxMomentaryLoudness(channels, sampleRate),
    truePeak: truePeak(channels, sampleRate),
  };
}
