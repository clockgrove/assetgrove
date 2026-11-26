/**
 * Core's audio kinds `sfx`, `ambience` and `music` (docs/PRD-audio.md, "Kinds"): one `audio` call
 * per candidate, then the kind's default recipe on the decoded WAV (resample, mono, trim, fade,
 * loop, gain) with every step recorded. The kinds declare the exact checks of `checks.ts`; core
 * runs them. A recipe step that refuses (gain at the true-peak ceiling) stops the recipe: the
 * candidate keeps the last step's samples and the refusal is recorded in `fields.audio.refused`,
 * which `audio:loudness` fails. An `sfx` under the 400 ms momentary window has no momentary
 * loudness to gain to, so it skips `gain` and true peak alone judges it, as the design says.
 */
import { z } from "zod";
import { InputError } from "../errors.ts";
import type { Generator, GeneratorContext, PlannedCall } from "../generators/generator.ts";
import { CORE_PROFILE_SCHEMA, CORE_SPEC_SCHEMA } from "../generators/spec-schema.ts";
import { withNote } from "../request.ts";
import { AUDIO_OPERATION } from "../routes.ts";
import type { Routes } from "../routes.ts";
import type { RecipeStep, TransformStep } from "../transform/types.ts";
import type { AssetSpec, TargetProfile } from "../types.ts";
import { AUDIO_CHECKS, loopFrames } from "./checks.ts";
import { decodeAudio, encodeWav } from "./engine.ts";
import type { AudioItem } from "./engine.ts";
import { measureLoudness } from "./loudness.ts";
import { audioSettings } from "./profile.ts";
import type { AudioKind, ResolvedAudioProfile } from "./profile.ts";
import { runAudioOperation } from "./run.ts";

/** What the loop's crossfade needs past the loop length, ms, and its curve, by kind. */
const AMBIENCE_CROSSFADE = { ms: 500, curve: "equal-power" } as const;
const MUSIC_CROSSFADE = { ms: 100, curve: "equal-gain" } as const;

/** Seconds added to a loop's requested duration so the overhang survives a resample's rounding. */
const OVERHANG_MARGIN_S = 0.01;

const brief = z.string().min(1);
const positive = z.number().finite().positive();

const requestedMusic = {
  instrumentation: z.string().optional(),
  sections: z.array(z.string()).optional(),
  theme: z.string().optional(),
  bpm: positive.optional(),
  meter: z.string().optional(),
  key: z.string().optional(),
};

/** The ids of a variant set of `count` members, in the plan's order: `subject-01` to `subject-NN`. */
export function variantIds(subject: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => variantId(subject, i + 1));
}

const variantId = (subject: string, variant: number): string =>
  `${subject}-${String(variant).padStart(2, "0")}`;

const SFX_SPEC_SCHEMA = CORE_SPEC_SCHEMA.extend({
  brief,
  maxDurationS: positive.max(30),
  variant: z.number().int().min(1).max(99).optional(),
}).superRefine((spec, context) => {
  if (spec.variant === undefined) return;
  if (spec.subject === undefined) {
    context.addIssue({
      code: "custom",
      path: ["subject"],
      message: `a variant needs the set's subject, and its assetId must be <subject>-${String(spec.variant).padStart(2, "0")}`,
    });
    return;
  }
  const id = variantId(spec.subject, spec.variant);
  if (spec.assetId !== id)
    context.addIssue({
      code: "custom",
      path: ["assetId"],
      message: `variant ${spec.variant} of subject ${spec.subject} must have assetId ${id}`,
    });
});

const AMBIENCE_SPEC_SCHEMA = CORE_SPEC_SCHEMA.extend({
  brief,
  loopS: positive,
});

const MUSIC_SPEC_SCHEMA = CORE_SPEC_SCHEMA.extend({
  brief,
  form: z.enum(["track", "cue"]),
  durationS: positive.optional(),
  loop: z
    .strictObject({
      bpm: positive,
      bars: positive,
      beatsPerBar: z.number().int().min(1),
    })
    .optional(),
  ...requestedMusic,
}).superRefine((spec, context) => {
  if (spec.loop !== undefined && spec.form !== "track")
    context.addIssue({
      code: "custom",
      path: ["loop"],
      message: "only a track loops; a cue has a start and an end",
    });
  if (spec.loop === undefined && spec.durationS === undefined)
    context.addIssue({
      code: "custom",
      path: ["durationS"],
      message: "a music spec without a loop needs durationS",
    });
});

function field<T>(spec: AssetSpec, name: string): T | undefined {
  return (spec as unknown as Record<string, T | undefined>)[name];
}

/** The loop's crossfade for a kind, or undefined for a kind or spec that does not loop. */
function crossfadeOf(
  spec: AssetSpec,
): typeof AMBIENCE_CROSSFADE | typeof MUSIC_CROSSFADE | undefined {
  if (spec.kind === "ambience") return AMBIENCE_CROSSFADE;
  if (spec.kind === "music" && field(spec, "loop") !== undefined) return MUSIC_CROSSFADE;
  return undefined;
}

/**
 * The duration asked of the provider: the clip's or track's own, or a loop's length plus the
 * crossfade as overhang, rounded up to 0.01 s and a margin.
 */
function requestedDurationS(spec: AssetSpec, settings: ResolvedAudioProfile): number {
  const loop = loopFrames(spec, settings.sampleRate);
  const crossfade = crossfadeOf(spec);
  if (loop !== undefined && crossfade !== undefined) {
    const seconds = loop.frames / settings.sampleRate + crossfade.ms / 1000;
    return Math.round((Math.ceil(seconds * 100 - 1e-9) / 100 + OVERHANG_MARGIN_S) * 100) / 100;
  }
  const given =
    spec.kind === "sfx" ? field<number>(spec, "maxDurationS") : field<number>(spec, "durationS");
  if (given === undefined) throw new InputError(`the ${spec.kind} spec asks for no duration`);
  return given;
}

/** The spec's requested fields, as recorded: asked for, never measured. */
function requestedOf(spec: AssetSpec): Record<string, unknown> {
  const names =
    spec.kind === "sfx"
      ? ["brief", "maxDurationS", "variant"]
      : spec.kind === "ambience"
        ? ["brief", "loopS"]
        : [
            "brief",
            "form",
            "durationS",
            "loop",
            "instrumentation",
            "sections",
            "theme",
            "bpm",
            "meter",
            "key",
          ];
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = field<unknown>(spec, name);
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function promptOf(spec: AssetSpec, durationS: number): string {
  const text = field<string>(spec, "brief")!.replace(/[.\s]+$/, "");
  const sentences = [`${text}.`];
  if (spec.kind === "sfx") {
    sentences.push(
      `A single sound effect, at most ${field<number>(spec, "maxDurationS")} seconds.`,
    );
  } else if (spec.kind === "ambience") {
    sentences.push(
      `An ambient bed that loops seamlessly, with a ${field<number>(spec, "loopS")}-second loop.`,
    );
  } else {
    const form = field<string>(spec, "form")!;
    const loop = field<{ bpm: number; bars: number; beatsPerBar: number }>(spec, "loop");
    sentences.push(
      loop
        ? `A music ${form} that loops seamlessly: ${loop.bars} bars of ${loop.beatsPerBar} beats at ${loop.bpm} bpm.`
        : `A music ${form}, ${durationS} seconds long.`,
    );
    const instrumentation = field<string>(spec, "instrumentation");
    if (instrumentation !== undefined) sentences.push(`Instrumentation: ${instrumentation}.`);
    const sections = field<string[]>(spec, "sections");
    if (sections !== undefined && sections.length > 0)
      sentences.push(`Sections: ${sections.join(", ")}.`);
    const theme = field<string>(spec, "theme");
    if (theme !== undefined) sentences.push(`Theme: ${theme}.`);
    const bpm = field<number>(spec, "bpm");
    if (bpm !== undefined && loop === undefined) sentences.push(`Tempo: ${bpm} bpm.`);
    const meter = field<string>(spec, "meter");
    if (meter !== undefined) sentences.push(`Meter: ${meter}.`);
    const key = field<string>(spec, "key");
    if (key !== undefined) sentences.push(`Key: ${key}.`);
  }
  return sentences.join(" ");
}

/** The default recipe's steps after the source has been decoded. */
function recipeOf(spec: AssetSpec, item: AudioItem, settings: ResolvedAudioProfile): RecipeStep[] {
  const kind = spec.kind as AudioKind;
  const steps: RecipeStep[] = [];
  if (item.sampleRate !== settings.sampleRate)
    steps.push({ op: "resample", params: { sampleRate: settings.sampleRate } });
  if (settings.channels[kind] === "mono" && item.channels.length > 1) steps.push({ op: "mono" });
  const { target, truePeakCeiling, encoderHeadroom } = settings.loudness;
  const gain = (measure: "integrated" | "momentary"): RecipeStep => ({
    op: "gain",
    params: { target, truePeakCeiling, encoderHeadroom, measure },
  });
  if (kind === "sfx") steps.push({ op: "trim-silence" }, { op: "fade" }, gain("momentary"));
  else {
    const crossfade = crossfadeOf(spec);
    const loop = field<{ bpm: number; bars: number; beatsPerBar: number }>(spec, "loop");
    if (crossfade !== undefined)
      steps.push({
        op: "loop",
        params: {
          ...(kind === "ambience"
            ? { seconds: field<number>(spec, "loopS") }
            : { bars: loop!.bars, beatsPerBar: loop!.beatsPerBar, bpm: loop!.bpm }),
          crossfadeMs: crossfade.ms,
          curve: crossfade.curve,
        },
      });
    steps.push(gain("integrated"));
  }
  return steps;
}

/** The momentary loudness window, s: a clip shorter than this has no momentary loudness. */
const MOMENTARY_WINDOW_S = 0.4;

const underMomentaryWindow = (item: AudioItem): boolean =>
  (item.channels[0]?.length ?? 0) / item.sampleRate < MOMENTARY_WINDOW_S;

/** A loudness figure as JSON: null where it is undefined (silence, or under 400 ms). */
const finiteOrNull = (value: number | null): number | null =>
  value !== null && Number.isFinite(value) ? value : null;

function audioGenerator(kind: AudioKind, specSchema: z.ZodType): Generator {
  return {
    kind,
    media: "audio",
    checks: AUDIO_CHECKS,
    specSchema,
    profileSchema: CORE_PROFILE_SCHEMA,
    operations: { [AUDIO_OPERATION]: "audio" },

    planCandidate(spec: AssetSpec, profile: TargetProfile, routes: Routes): PlannedCall[] {
      const settings = audioSettings(profile);
      const route = routes[AUDIO_OPERATION];
      if (!route) throw new InputError(`no model route for operation "${AUDIO_OPERATION}"`);
      requestedDurationS(spec, settings);
      return [
        {
          operation: AUDIO_OPERATION,
          model: route.model,
          estimatedCostUsd: route.estimatedCostUsd,
        },
      ];
    },

    async generate(context: GeneratorContext) {
      const { spec, profile, call } = context;
      const settings = audioSettings(profile);
      const durationS = requestedDurationS(spec, settings);
      const prompt = withNote(promptOf(spec, durationS), context.note);
      const made = await call.audio(AUDIO_OPERATION, prompt, {
        parameters: { durationS, seed: context.seed },
      });
      const source = decodeAudio(made.bytes, spec.assetId ?? kind);
      source.bitDepth = settings.bitDepth;

      let items = [source];
      const steps: TransformStep[] = [];
      let refused: string | undefined;
      for (const step of recipeOf(spec, source, settings)) {
        if (step.op === "gain" && kind === "sfx" && underMomentaryWindow(items[0]!)) continue;
        try {
          const ran = await runAudioOperation(items, step);
          items = ran.items;
          steps.push(ran.step);
        } catch (error) {
          if (!(error instanceof InputError)) throw error;
          refused = error.message;
          break;
        }
      }
      const master = items[0]!;
      const bytes = encodeWav(master);
      const decoded = decodeAudio(bytes);
      const measure = measureLoudness(decoded.channels, decoded.sampleRate);
      const loop = loopFrames(spec, decoded.sampleRate);
      const frames = decoded.channels[0]?.length ?? 0;
      const form = field<string>(spec, "form");
      const loudness = {
        integrated: finiteOrNull(measure.integrated),
        momentaryMax: finiteOrNull(measure.momentaryMax),
        truePeak: finiteOrNull(measure.truePeak),
      };
      return {
        output: {
          mediaType: "audio/wav",
          extension: "wav",
          bytes,
          fields: {
            audio: {
              kind,
              ...(form !== undefined && { form }),
              requested: requestedOf(spec),
              steps,
              sampleRate: decoded.sampleRate,
              channels: decoded.channels.length,
              bitDepth: decoded.bitDepth,
              frames,
              durationS: frames / decoded.sampleRate,
              loudness,
              ...(loop !== undefined && { loop: { frames: loop.frames, residual: loop.residual } }),
              ...(refused !== undefined && { refused }),
            },
          },
        },
        qa: { passed: true, reasons: [] },
        prompt,
        parameters: {
          durationS,
          recipe: steps.map((s) => s.op),
          loudnessTarget: settings.loudness.target,
          ...(refused !== undefined && { refused }),
        },
      };
    },
  };
}

export const sfxGenerator = audioGenerator("sfx", SFX_SPEC_SCHEMA);
export const ambienceGenerator = audioGenerator("ambience", AMBIENCE_SPEC_SCHEMA);
export const musicGenerator = audioGenerator("music", MUSIC_SPEC_SCHEMA);

/** Core's audio kinds, in the order the registry lists them. */
export const audioGenerators: Generator[] = [sfxGenerator, ambienceGenerator, musicGenerator];
