/**
 * The exact checks of the audio kinds (docs/PRD-audio.md, "Exact checks"): deterministic, free, and
 * every one reads the decoded master, the spec and the profile's `audio` block. Each check returns
 * exactly one reason; a check that does not apply to the spec's kind returns a passing reason that
 * says so, so every candidate carries the same nine reasons.
 */
import { decodeAudio, sampleHash } from "./engine.ts";
import { measureLoudness } from "./loudness.ts";
import { audioSettings } from "./profile.ts";
import type { AudioKind } from "./profile.ts";
import type { KindCheck, KindCheckInput } from "../generators/generator.ts";
import { decodeWav } from "../media.ts";
import type { AudioContext } from "../media.ts";
import type { TransformStep } from "../transform/types.ts";
import type { Reason } from "../types.ts";

/** The reason name of the variant-set loudness check `audit` runs. */
export const SET_LOUDNESS_CHECK = "audio:set-loudness";

/** The floor, dBFS, below which a sample is silence: the `trim-silence` default. */
const SILENCE_FLOOR_DB = -60;

/** A loop's length in frames and the fraction of a frame dropped. */
export interface LoopFrames {
  frames: number;
  residual: number;
}

function field(spec: object, name: string): unknown {
  return (spec as Record<string, unknown>)[name];
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The frames an `ambience` or a looping `music` track loops over, as the `loop` operation counts
 * them: `floor(loopS × rate)` or Godot's `floor(bars × beatsPerBar × 60 / bpm × rate)`, with a
 * product within rounding error of a whole frame snapped to it. Undefined for `sfx` and music
 * without a loop.
 */
export function loopFrames(spec: object, sampleRate: number): LoopFrames | undefined {
  let raw: number | undefined;
  const kind = field(spec, "kind");
  if (kind === "ambience") {
    const loopS = num(field(spec, "loopS"));
    if (loopS !== undefined) raw = loopS * sampleRate;
  } else if (kind === "music") {
    const loop = field(spec, "loop") as Record<string, unknown> | undefined;
    const bpm = num(loop?.["bpm"]);
    const bars = num(loop?.["bars"]);
    const beatsPerBar = num(loop?.["beatsPerBar"]);
    if (bpm !== undefined && bars !== undefined && beatsPerBar !== undefined && bpm > 0)
      raw = (bars * beatsPerBar * 60 * sampleRate) / bpm;
  }
  if (raw === undefined) return undefined;
  const nearest = Math.round(raw);
  const exact = Math.abs(raw - nearest) <= 1e-6 ? nearest : raw;
  const frames = Math.floor(exact);
  return { frames, residual: exact - frames };
}

/** The loudness a member of a variant set is judged by: `sfx` its momentary maximum, others integrated. */
export function memberLoudness(kind: string, audio: AudioContext): number | null {
  const measure = measureLoudness(audio.channels, audio.sampleRate);
  return kind === "sfx" ? measure.momentaryMax : measure.integrated;
}

/** The momentary window an `sfx` is measured over; a shorter clip has no momentary loudness. */
const MOMENTARY_WINDOW_S = 0.4;

/**
 * An `sfx` shorter than the 400 ms momentary window: its length in milliseconds, since the
 * Loudness rule judges such a clip by true peak alone. Undefined for a longer clip or another kind.
 */
export function shortClipMs(kind: string, audio: AudioContext): number | undefined {
  const seconds = (audio.channels[0]?.length ?? 0) / audio.sampleRate;
  return kind === "sfx" && seconds < MOMENTARY_WINDOW_S ? seconds * 1000 : undefined;
}

/** The median of a set's defined loudnesses; null when none is defined. */
export function medianLoudness(values: readonly (number | null)[]): number | null {
  const known = values.filter((l): l is number => l !== null).sort((a, b) => a - b);
  if (known.length === 0) return null;
  const mid = Math.floor(known.length / 2);
  return known.length % 2 ? known[mid]! : (known[mid - 1]! + known[mid]!) / 2;
}

/**
 * Each member of a variant set within `spreadLu` of the set's median loudness passes. A member
 * under the 400 ms momentary window (`shortMs`) has no loudness to compare: true peak alone judges
 * it (`audio:true-peak`), so it passes saying so and stays out of the median.
 */
export function setLoudness(
  members: { id: string; loudness: number | null; shortMs?: number }[],
  spreadLu: number,
): Reason[] {
  const median = medianLoudness(members.map((m) => (m.shortMs === undefined ? m.loudness : null)));
  return members.map((m) => {
    if (m.shortMs !== undefined)
      return reason(
        SET_LOUDNESS_CHECK,
        true,
        `${m.id} is ${fixed(m.shortMs)} ms, under the 400 ms momentary window, so true peak alone judges it (audio:true-peak), not the set's loudness`,
      );
    if (m.loudness === null || median === null)
      return reason(
        SET_LOUDNESS_CHECK,
        false,
        `${m.id} has no defined loudness to compare with the set`,
      );
    const off = Math.abs(m.loudness - median);
    return reason(
      SET_LOUDNESS_CHECK,
      off <= spreadLu,
      `${m.id} is ${fixed(m.loudness)} LUFS, ${fixed(off)} LU from the set median ${fixed(median)} LUFS (limit ${fixed(spreadLu)} LU)`,
    );
  });
}

function fixed(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : String(n);
}

function reason(check: string, passed: boolean, text: string): Reason {
  return { check, passed, reason: text, source: "deterministic" };
}

interface Context {
  input: KindCheckInput;
  audio: AudioContext;
  kind: string;
  settings: ReturnType<typeof audioSettings>;
}

function stepsOf(input: KindCheckInput): TransformStep[] {
  const audio = input.output.fields["audio"] as { steps?: TransformStep[] } | undefined;
  return audio?.steps ?? [];
}

function masterHash(input: KindCheckInput): string {
  return sampleHash(decodeAudio(input.output.bytes));
}

/** True when each step's inputs are the previous step's outputs and the last output is `hash`. */
function chains(steps: TransformStep[], hash: string): boolean {
  if (steps.length === 0) return false;
  for (let i = 1; i < steps.length; i++)
    if (steps[i]!.inputs.join() !== steps[i - 1]!.outputs.join()) return false;
  return steps[steps.length - 1]!.outputs[0] === hash;
}

const notApplicable = (check: string, kind: string): Reason =>
  reason(check, true, `${check} does not apply to ${kind}`);

type Run = (c: Context) => Reason;

function check(name: string, run: Run): KindCheck {
  return {
    name,
    mode: "exact",
    source: "deterministic",
    run(input) {
      const audio = input.audio ?? decodeWav(input.output.bytes);
      const kind = input.spec.kind;
      return [run({ input, audio, kind, settings: audioSettings(input.profile) })];
    },
  };
}

function layoutCount(layout: string): number {
  return layout === "stereo" ? 2 : 1;
}

function silentEdges(audio: AudioContext): { lead: number; trail: number; frames: number } {
  const limit = 10 ** (SILENCE_FLOOR_DB / 20);
  const frames = audio.channels[0]?.length ?? 0;
  const loud = (i: number) => audio.channels.some((c) => Math.abs(c[i]!) >= limit);
  let lead = 0;
  while (lead < frames && !loud(lead)) lead++;
  if (lead === frames) return { lead, trail: frames, frames };
  let trail = 0;
  while (!loud(frames - 1 - trail)) trail++;
  return { lead, trail, frames };
}

const FORMAT = check("audio:format", ({ audio, kind, settings }) => {
  const want = layoutCount(settings.channels[kind as AudioKind] ?? "mono");
  const problems: string[] = [];
  if (audio.sampleRate !== settings.sampleRate)
    problems.push(`sample rate ${audio.sampleRate} Hz, profile ${settings.sampleRate} Hz`);
  if (audio.channelCount !== want)
    problems.push(
      `${audio.channelCount} channels, profile ${want} (${settings.channels[kind as AudioKind]})`,
    );
  if (audio.bitDepth !== settings.bitDepth)
    problems.push(`bit depth ${audio.bitDepth}, profile ${settings.bitDepth}`);
  return problems.length > 0
    ? reason("audio:format", false, `the master has ${problems.join("; ")}`)
    : reason(
        "audio:format",
        true,
        `${audio.sampleRate} Hz, ${audio.channelCount} channels, ${audio.bitDepth}-bit as the profile sets`,
      );
});

const DURATION = check("audio:duration", ({ input, audio, kind, settings }) => {
  const name = "audio:duration";
  const frames = audio.channels[0]?.length ?? 0;
  const seconds = frames / audio.sampleRate;
  const spec = input.spec;
  if (kind === "sfx") {
    const max = num(field(spec, "maxDurationS"));
    if (max === undefined) return reason(name, true, "the spec sets no maxDurationS");
    return reason(name, seconds <= max, `the clip is ${fixed(seconds)} s, limit ${fixed(max)} s`);
  }
  const loop = loopFrames(spec, audio.sampleRate);
  if (loop !== undefined)
    return reason(
      name,
      frames === loop.frames,
      `the master is ${frames} frames, the loop is ${loop.frames} frames`,
    );
  const want = num(field(spec, "durationS"));
  if (want === undefined) return reason(name, true, "the spec sets no durationS");
  const tol = settings.durationToleranceS;
  return reason(
    name,
    Math.abs(seconds - want) <= tol,
    `the master is ${fixed(seconds)} s, ${fixed(want)} s ± ${fixed(tol)} s wanted`,
  );
});

const TRUE_PEAK = check("audio:true-peak", ({ audio, settings }) => {
  const { truePeakCeiling, encoderHeadroom } = settings.loudness;
  const limit = truePeakCeiling - encoderHeadroom;
  const peak = measureLoudness(audio.channels, audio.sampleRate).truePeak;
  return reason(
    "audio:true-peak",
    peak <= limit,
    `the true peak is ${fixed(peak)} dBTP, limit ${fixed(limit)} dBTP (ceiling ${fixed(truePeakCeiling)}, headroom ${fixed(encoderHeadroom)})`,
  );
});

const LOUDNESS = check("audio:loudness", ({ input, audio, kind, settings }) => {
  const name = "audio:loudness";
  const { target, tolerance, truePeakCeiling, encoderHeadroom } = settings.loudness;
  const refused = (input.output.fields["audio"] as { refused?: string } | undefined)?.refused;
  if (refused !== undefined)
    return reason(name, false, `the recipe stopped before the loudness was set: ${refused}`);
  const measure = measureLoudness(audio.channels, audio.sampleRate);
  const sfx = kind === "sfx";
  const value = sfx ? measure.momentaryMax : measure.integrated;
  if (value === null) {
    const frames = audio.channels[0]?.length ?? 0;
    if (sfx && measure.truePeak > -Infinity && frames / audio.sampleRate < MOMENTARY_WINDOW_S) {
      const limit = truePeakCeiling - encoderHeadroom;
      return reason(
        name,
        measure.truePeak <= limit,
        `the clip is ${fixed((frames / audio.sampleRate) * 1000)} ms, under the 400 ms momentary window, so true peak alone decides: ${fixed(measure.truePeak)} dBTP, limit ${fixed(limit)} dBTP`,
      );
    }
    return reason(name, false, "the loudness is undefined (silence)");
  }
  return reason(
    name,
    Math.abs(value - target) <= tolerance,
    `the ${sfx ? "maximum momentary" : "integrated"} loudness is ${fixed(value)} LUFS, target ${fixed(target)} ± ${fixed(tolerance)} LU`,
  );
});

const SILENCE = check("audio:silence", ({ audio, kind, settings }) => {
  const name = "audio:silence";
  if (kind !== "sfx") return notApplicable(name, kind);
  const { lead, trail, frames } = silentEdges(audio);
  if (frames === 0 || lead === frames)
    return reason(
      name,
      false,
      `the clip is silent throughout (${fixed((frames / audio.sampleRate) * 1000)} ms)`,
    );
  const leadMs = (lead / audio.sampleRate) * 1000;
  const trailMs = (trail / audio.sampleRate) * 1000;
  const limit = settings.silenceLimitMs;
  return reason(
    name,
    leadMs <= limit && trailMs <= limit,
    `leading silence ${fixed(leadMs)} ms, trailing silence ${fixed(trailMs)} ms, limit ${fixed(limit)} ms each`,
  );
});

const FADE = check("audio:fade", ({ input, kind }) => {
  const name = "audio:fade";
  if (kind !== "sfx") return notApplicable(name, kind);
  const steps = stepsOf(input);
  if (!steps.some((s) => s.op === "fade"))
    return reason(name, false, "the recipe has no fade step");
  return chains(steps, masterHash(input))
    ? reason(name, true, "the recipe's fade step is in a chain that ends at the master")
    : reason(
        name,
        false,
        "the recipe's steps do not chain to the master's samples after the fade step",
      );
});

const LOOP = check("audio:loop", ({ input, audio, kind }) => {
  const name = "audio:loop";
  if (loopFrames(input.spec, audio.sampleRate) === undefined) return notApplicable(name, kind);
  const steps = stepsOf(input);
  const at = steps.findIndex((s) => s.op === "loop");
  if (at < 0) return reason(name, false, "the recipe has no loop step");
  return chains(steps.slice(at), masterHash(input))
    ? reason(name, true, "the recipe's loop step leads to the master")
    : reason(
        name,
        false,
        "the recipe's steps from the loop step do not lead to the master's samples",
      );
});

const FAKE_STEREO = check("audio:fake-stereo", ({ audio }) => {
  const name = "audio:fake-stereo";
  const [first, ...rest] = audio.channels;
  if (first === undefined || rest.length === 0)
    return reason(name, true, `the file has ${audio.channelCount} channel; nothing to duplicate`);
  const same = rest.every((c) => c.length === first.length && c.every((v, i) => v === first[i]));
  return same
    ? reason(
        name,
        false,
        `all ${audio.channelCount} channels are identical; use the mono recipe step to make a mono master`,
      )
    : reason(name, true, `the ${audio.channelCount} channels differ`);
});

/** The audio kinds' exact checks, in the order a candidate's reasons list them. */
export const AUDIO_CHECKS: KindCheck[] = [
  FORMAT,
  DURATION,
  TRUE_PEAK,
  LOUDNESS,
  SILENCE,
  FADE,
  LOOP,
  FAKE_STEREO,
];
