/**
 * The target profile's `audio` block (docs/PRD-audio.md, "Media" and "Loudness"): the sample rate,
 * bit depth and channel layout of each audio kind's master, the tolerances its exact checks use, and
 * the `loudness` block, which has no default. An audio kind on a profile without `audio.loudness`
 * is refused at plan, naming the block.
 */
import { z } from "zod";
import { InputError } from "../errors.ts";
import type { TargetProfile } from "../types.ts";

/** Core's audio kinds. */
export const AUDIO_KINDS = ["sfx", "ambience", "music"] as const;
export type AudioKind = (typeof AUDIO_KINDS)[number];

/** A channel layout a profile may set for an audio kind. */
export type AudioLayout = "mono" | "stereo";

/** The loudness block: what the `gain` step aims for and the checks judge. */
export interface AudioLoudness {
  /** The loudness target, LUFS. */
  target: number;
  /** How far, in LU, a master may sit from the target. */
  tolerance: number;
  /** The true-peak ceiling, dBTP. */
  truePeakCeiling: number;
  /** dB kept under the ceiling for a lossy encoder. */
  encoderHeadroom: number;
}

/** The profile's `audio` block as written; every field optional. */
export interface AudioProfile {
  /** Hz; default 44100, Godot's mix rate. */
  sampleRate?: number;
  /** The master's bit depth as wavefile names it; default `"16"`. */
  bitDepth?: string;
  /** Each kind's channel layout; default `sfx` mono, `ambience` and `music` stereo. */
  channels?: Partial<Record<AudioKind, AudioLayout>>;
  /** No default: an audio kind on a profile without it is refused at plan. */
  loudness?: AudioLoudness;
  /** How far, in seconds, a track or cue may sit from its brief's duration; default 0.5. */
  durationToleranceS?: number;
  /** The most leading or trailing silence an `sfx` may keep, ms; default 50. */
  silenceLimitMs?: number;
  /** How far, in LU, a variant set's member may sit from the set's median loudness; default 2. */
  setSpreadLu?: number;
}

/** The `audio` block with every default filled and the loudness block present. */
export interface ResolvedAudioProfile {
  sampleRate: number;
  bitDepth: string;
  channels: Record<AudioKind, AudioLayout>;
  loudness: AudioLoudness;
  durationToleranceS: number;
  silenceLimitMs: number;
  setSpreadLu: number;
}

export const AUDIO_DEFAULTS = {
  sampleRate: 44100,
  bitDepth: "16",
  channels: { sfx: "mono", ambience: "stereo", music: "stereo" },
  durationToleranceS: 0.5,
  silenceLimitMs: 50,
  setSpreadLu: 2,
} as const satisfies Omit<ResolvedAudioProfile, "loudness">;

/**
 * The EBU R128 reference `init` offers for `audio.loudness`: −23 LUFS integrated and a −1 dBTP
 * true-peak ceiling (EBU R 128, "Loudness normalisation and permitted maximum level of audio
 * signals"; EBU Tech 3343 for production practice). Offered, never written as a default.
 */
export const EBU_R128_REFERENCE = {
  target: -23,
  truePeakCeiling: -1,
  source:
    "EBU R 128 (loudness normalisation and permitted maximum level of audio signals), https://tech.ebu.ch/publications/r128",
} as const;

const finite = z.number().finite();

/** The `loudness` block's schema, shared by the profile and the developer settings. */
export const audioLoudnessSchema = z.strictObject({
  target: finite.max(0),
  tolerance: finite.min(0),
  truePeakCeiling: finite.max(0),
  encoderHeadroom: finite.min(0),
});

const layout = z.enum(["mono", "stereo"]);

/** The profile's `audio` block's schema. */
export const audioProfileSchema = z.strictObject({
  sampleRate: z.number().int().min(1000).optional(),
  bitDepth: z.enum(["8", "16", "24", "32", "32f", "64"]).optional(),
  channels: z
    .strictObject({ sfx: layout.optional(), ambience: layout.optional(), music: layout.optional() })
    .optional(),
  loudness: audioLoudnessSchema.optional(),
  durationToleranceS: finite.min(0).optional(),
  silenceLimitMs: finite.min(0).optional(),
  setSpreadLu: finite.min(0).optional(),
});

/**
 * The profile's `audio` block with its defaults; throws an InputError naming `audio.loudness` when
 * the profile has no loudness block, and naming the field when the block is invalid.
 */
export function audioSettings(profile: TargetProfile): ResolvedAudioProfile {
  const parsed = audioProfileSchema.safeParse(profile.audio ?? {});
  if (!parsed.success)
    throw new InputError(
      `the target profile "${profile.name}" has an invalid audio block: ${parsed.error.issues
        .map((issue) => `audio.${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  const block = parsed.data;
  if (block.loudness === undefined)
    throw new InputError(
      `the target profile "${profile.name}" has no audio.loudness block (target, tolerance, truePeakCeiling, encoderHeadroom), which audio kinds need and which has no default; set it in the profile, or in the developer settings' audio.loudness for a headless setup (EBU R128's reference is ${EBU_R128_REFERENCE.target} LUFS and ${EBU_R128_REFERENCE.truePeakCeiling} dBTP)`,
    );
  return {
    sampleRate: block.sampleRate ?? AUDIO_DEFAULTS.sampleRate,
    bitDepth: block.bitDepth ?? AUDIO_DEFAULTS.bitDepth,
    channels: { ...AUDIO_DEFAULTS.channels, ...block.channels },
    loudness: block.loudness,
    durationToleranceS: block.durationToleranceS ?? AUDIO_DEFAULTS.durationToleranceS,
    silenceLimitMs: block.silenceLimitMs ?? AUDIO_DEFAULTS.silenceLimitMs,
    setSpreadLu: block.setSpreadLu ?? AUDIO_DEFAULTS.setSpreadLu,
  };
}

/** The profile's variant-set loudness spread, LU, which needs no `audio.loudness` block. */
export function audioSetSpread(profile: TargetProfile): number {
  const parsed = audioProfileSchema.safeParse(profile.audio ?? {});
  return (parsed.success ? parsed.data.setSpreadLu : undefined) ?? AUDIO_DEFAULTS.setSpreadLu;
}

/**
 * The profile with the developer settings' `audio.loudness` filled in where the profile has none:
 * how a headless setup sets the block. A profile's own block wins; the profile given is unchanged.
 */
export function withSettingsLoudness(
  profile: TargetProfile,
  settingsLoudness: AudioLoudness | undefined,
): TargetProfile {
  if (settingsLoudness === undefined || profile.audio?.loudness !== undefined) return profile;
  return { ...profile, audio: { ...profile.audio, loudness: settingsLoudness } };
}
