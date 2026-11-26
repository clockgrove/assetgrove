/**
 * The `godot:audio` preset: a sound effect, an ambience loop or a piece of music handed off to a
 * Godot project. The default delivery is the WAV core writes, its loop points in the RIFF `smpl`
 * chunk, which Godot's importer reads with its default loop mode; the preset writes no `.import`
 * for a WAV, so the developer's import settings stay theirs. `format: "ogg"` delivers core's Ogg
 * Vorbis rendition of the master instead: Godot imports it in scratch (src/scratch.ts) with the
 * loop and tempo import options the version implies, and the preset returns the `.import` Godot
 * wrote only when the target has none. A variant set (`sfx` assets sharing a `subject`) gets one
 * `AudioStreamRandomizer` per subject, built by Godot, an existing one merged into and keeping its
 * UID.
 *
 * Godot runs only when there is something to build, and then reads the imported stream's loop
 * points and tempo back and fails naming the property when they differ from the version's. The
 * check reads the target: the WAV's `smpl` loop, and an existing `.import` that disagrees with the
 * delivered version's loop points or tempo is a problem naming the setting.
 */
import { posix } from "node:path";
import type {
  EnginePreset,
  ExtensionContext,
  PresetContext,
  PresetFile,
  TargetRead,
} from "@clockgrove/assetgrove/extension";
import { externalReferences, importParams, importUid, resourceHeader } from "./godot-text.ts";
import { dependencies } from "./references.ts";
import { GodotInputError, inProject, relativePath, runGodot, savedFile } from "./run.ts";
import { GODOT_RELEASE } from "./setup.ts";
import { godotDoctor } from "./doctor.ts";
import { godotUsage } from "./usage.ts";
import {
  INPUT_PATH,
  importOptionsSchema,
  projectFiles,
  type AudioInput,
  type ImportOption,
} from "./scratch.ts";

export const AUDIO_PRESET = "godot:audio";
export const WAV_MEDIA_TYPE = "audio/wav";

export interface AudioOptions {
  /** The Godot project's directory (where `project.godot` is), relative to the target. */
  project: string;
  /** What is delivered as the stream: the master's WAV, or the Ogg Vorbis rendition. */
  format: "wav" | "ogg";
  /** The Ogg's quality, -1 to 10; core's default when absent. */
  quality?: number | undefined;
  /** The Ogg, relative to the target, `{assetId}` replaced; empty is the WAV's path as `.ogg`. */
  ogg: string;
  /**
   * The variant set's AudioStreamRandomizer, relative to the target, `{subject}` replaced; empty
   * is `{subject}.tres` beside the stream.
   */
  randomizer: string;
  /** Godot Ogg import options by their `.import` key, applied to an Ogg the target has no `.import` for. */
  import: Record<string, ImportOption>;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** The hand-off's audio: what the preset needs of the asset. */
export interface AudioAsset {
  assetId: string;
  /** The WAV, relative to the target, with `/`. */
  media: string;
  /** The loop the version has: the whole file. */
  loop?: { begin: number; end: number };
  /** The frames of the file. */
  frames?: number;
  /** A music loop's tempo, as Godot's Ogg import options hold it. */
  tempo?: { bpm: number; beatCount: number; barBeats: number };
  /** The subject of a variant-set member. */
  subject?: string;
}

/** The asset's WAV, loop and tempo from the hand-off context; media that is not a WAV is refused. */
export function audioAsset(ctx: PresetContext): AudioAsset {
  const spec = record(ctx.context["spec"]);
  const output = record(ctx.context["output"]);
  const path = output["path"];
  if (typeof path !== "string" || path === "")
    throw new GodotInputError(`the hand-off names no media path (output.path)`);
  const mediaType = output["mediaType"];
  if (mediaType !== WAV_MEDIA_TYPE || !/\.wav$/i.test(path))
    throw new GodotInputError(
      `the preset ${AUDIO_PRESET} hands off a WAV (.wav, ${WAV_MEDIA_TYPE}), not ${path}${typeof mediaType === "string" ? ` (${mediaType})` : ""}`,
    );
  const assetId = spec["assetId"];
  if (typeof assetId !== "string" || assetId === "")
    throw new GodotInputError(`the hand-off names no asset (spec.assetId)`);
  const audio = record(output["audio"]);
  const asset: AudioAsset = { assetId, media: relativePath(path, "the audio") };
  if (isNumber(audio["frames"])) asset.frames = audio["frames"];
  const loop = record(audio["loop"]);
  if (loop["frames"] !== undefined) {
    if (!isNumber(loop["frames"]) || !Number.isInteger(loop["frames"]) || loop["frames"] <= 0)
      throw new GodotInputError(`the hand-off's output.audio.loop.frames is not a frame count`);
    asset.loop = { begin: 0, end: loop["frames"] };
  }
  const tempo = record(spec["loop"]);
  if (spec["kind"] === "music" && Object.keys(tempo).length > 0) {
    const { bpm, bars, beatsPerBar } = tempo;
    if (!isNumber(bpm) || !isNumber(bars) || !isNumber(beatsPerBar))
      throw new GodotInputError(`the spec's loop has no bpm, bars and beatsPerBar`);
    asset.tempo = { bpm, beatCount: Math.round(bars * beatsPerBar), barBeats: beatsPerBar };
  }
  if (spec["kind"] === "sfx" && typeof spec["subject"] === "string" && isNumber(spec["variant"]))
    asset.subject = spec["subject"];
  return asset;
}

/** Where the preset's files are, all relative to the target. */
interface Layout {
  project: string;
  /** The stream the version is delivered as. */
  stream: string;
  /** The AudioStreamRandomizer of a variant set. */
  randomizer?: string;
}

function layoutOf(asset: AudioAsset, options: AudioOptions): Layout {
  const project = relativePath(options.project, "options.project");
  inProject(project, asset.media, "the audio");
  let stream = asset.media;
  if (options.format === "ogg") {
    const given = options.ogg.replaceAll("{assetId}", asset.assetId);
    stream = relativePath(
      given === "" ? asset.media.replace(/\.wav$/i, ".ogg") : given,
      "options.ogg",
    );
    if (!stream.endsWith(".ogg"))
      throw new GodotInputError(`options.ogg ${JSON.stringify(stream)} must end in .ogg`);
    inProject(project, stream, "the Ogg");
  }
  const layout: Layout = { project, stream };
  if (asset.subject !== undefined) {
    const given = options.randomizer.replaceAll("{subject}", asset.subject);
    const randomizer = relativePath(
      given === "" ? posix.join(posix.dirname(stream), `${asset.subject}.tres`) : given,
      "options.randomizer",
    );
    if (!randomizer.endsWith(".tres"))
      throw new GodotInputError(
        `options.randomizer ${JSON.stringify(randomizer)} must end in .tres`,
      );
    inProject(project, randomizer, "the randomizer");
    layout.randomizer = randomizer;
  }
  return layout;
}

/** The Ogg import options the version implies; they win over the options the developer gave. */
function oggParams(asset: AudioAsset): Record<string, ImportOption> {
  if (asset.loop === undefined) return { loop: false };
  return {
    loop: true,
    loop_offset: 0,
    ...(asset.tempo !== undefined && {
      bpm: asset.tempo.bpm,
      beat_count: asset.tempo.beatCount,
      bar_beats: asset.tempo.barBeats,
    }),
  };
}

async function write(
  audio: ExtensionContext["audio"],
  ctx: PresetContext,
  options: AudioOptions,
  read: TargetRead,
): Promise<PresetFile[]> {
  const asset = audioAsset(ctx);
  const { project, stream, randomizer } = layoutOf(asset, options);
  const streamAt = inProject(project, stream, "the stream");
  const ogg = options.format === "ogg";
  const files: PresetFile[] = [];
  let bytes: Uint8Array | undefined;
  if (ogg || randomizer !== undefined) {
    const master = ctx.mediaBytes ?? (await read(asset.media));
    if (master === undefined) throw new GodotInputError(`the audio ${asset.media} cannot be read`);
    bytes = master;
  }
  if (ogg) {
    const rendition = await audio.oggRendition(
      bytes!,
      options.quality === undefined ? undefined : { quality: options.quality },
    );
    bytes = rendition.bytes;
    files.push({ path: stream, content: rendition.bytes });
  }
  // An existing .import keeps its UID and options; it reaches scratch as data only.
  const existingImport =
    ogg || randomizer !== undefined ? await read(`${stream}.import`) : undefined;
  const fresh = ogg && existingImport === undefined;
  if (!fresh && randomizer === undefined) return files;

  const scratch: Record<string, Uint8Array | string> = { ...projectFiles(), [streamAt]: bytes! };
  if (existingImport !== undefined) scratch[`${streamAt}.import`] = existingImport;
  const imports = [`res://${streamAt}`];
  let before: Uint8Array | undefined;
  let randomizerInput: AudioInput["randomizer"];
  if (randomizer !== undefined) {
    const randomizerAt = inProject(project, randomizer, "the randomizer");
    before = await read(randomizer);
    const uid = before === undefined ? undefined : resourceHeader(before)?.uid;
    if (before !== undefined) {
      scratch[randomizerAt] = before;
      // This hand-off's stream stays its bytes: the target's older ones are never loaded.
      const seen = new Set([randomizerAt, streamAt, `${streamAt}.import`]);
      imports.push(...(await dependencies(project, randomizerAt, before, read, scratch, seen)));
      // The other members' WAVs come without an `.import` (none is ever written): the editor
      // imports them in scratch, and the build waits for that before it loads the randomizer.
      for (const path of Object.keys(scratch))
        if (/\.(wav|ogg)$/i.test(path) && !imports.includes(`res://${path}`))
          imports.push(`res://${path}`);
    }
    randomizerInput = {
      resource: `res://${randomizerAt}`,
      existing: before !== undefined,
      ...(uid !== undefined && { uid }),
    };
  }
  const input: AudioInput = {
    build: "audio",
    godot: GODOT_RELEASE.release,
    stream: `res://${streamAt}`,
    format: options.format,
    fresh: fresh ? [`res://${streamAt}`] : [],
    options: { ...options.import, ...oggParams(asset) },
    expected: {
      ...(asset.loop !== undefined && { loop: asset.loop }),
      ...(asset.tempo !== undefined && { tempo: asset.tempo }),
    },
    imports,
    ...(randomizerInput !== undefined && { randomizer: randomizerInput }),
  };
  scratch[INPUT_PATH] = JSON.stringify(input, null, 2);

  const { ran } = await runGodot(AUDIO_PRESET, ctx.run, scratch);
  if (fresh)
    files.push({
      path: `${stream}.import`,
      content: savedFile(AUDIO_PRESET, ran, project, `${stream}.import`),
    });
  if (randomizer !== undefined)
    files.push({
      path: randomizer,
      content: savedFile(AUDIO_PRESET, ran, project, randomizer, before),
    });
  return files;
}

/** An `.import` value as a number, or undefined when it is none. */
const numeric = (value: string | undefined): number | undefined =>
  value === undefined || value.trim() === "" || !Number.isFinite(Number(value))
    ? undefined
    : Number(value);

const LOOP_MODES = ["Detect From WAV", "Disabled", "Forward", "Ping-Pong", "Backward"];

/** What an existing Ogg `.import` holds that the delivered version does not. */
function oggImportProblems(
  at: string,
  params: Record<string, string>,
  asset: AudioAsset,
): string[] {
  const problems: string[] = [];
  const same = (key: string, fallback: number, want: number) => {
    const has = numeric(params[key]) ?? fallback;
    if (has !== want)
      problems.push(
        `${at}: ${key} is ${params[key] ?? `${fallback} (Godot's default)`}, the delivered version has ${want}`,
      );
  };
  const loops = params["loop"] === "true";
  if (loops !== (asset.loop !== undefined))
    problems.push(
      `${at}: loop is ${params["loop"] ?? "false (Godot's default)"}, the delivered version has ${asset.loop !== undefined}`,
    );
  if (asset.loop !== undefined) same("loop_offset", 0, 0);
  if (asset.tempo !== undefined) {
    same("bpm", 0, asset.tempo.bpm);
    same("beat_count", 0, asset.tempo.beatCount);
    same("bar_beats", 4, asset.tempo.barBeats);
  }
  return problems;
}

/** What an existing WAV `.import` holds that the delivered version's loop does not agree with. */
function wavImportProblems(
  at: string,
  params: Record<string, string>,
  asset: AudioAsset,
): string[] {
  const mode = numeric(params["edit/loop_mode"]) ?? 0;
  const name = `${params["edit/loop_mode"] ?? "0"} (${LOOP_MODES[mode] ?? "unknown"})`;
  if (mode === 0) return [];
  if (mode === 2 && asset.loop === undefined)
    return [`${at}: edit/loop_mode is ${name}, the delivered version does not loop`];
  if (asset.loop === undefined) return [];
  if (mode !== 2) return [`${at}: edit/loop_mode is ${name}, the delivered version loops forward`];
  const problems: string[] = [];
  const begin = numeric(params["edit/loop_begin"]) ?? 0;
  if (begin !== asset.loop.begin)
    problems.push(
      `${at}: edit/loop_begin is ${begin}, the delivered version loops from ${asset.loop.begin}`,
    );
  const end = numeric(params["edit/loop_end"]) ?? -1;
  if (end !== -1 && end !== (asset.frames ?? asset.loop.end))
    problems.push(
      `${at}: edit/loop_end is ${end}, the delivered version loops to ${asset.frames ?? asset.loop.end}`,
    );
  return problems;
}

/** What the randomizer is wrong in, read back as text. */
async function randomizerProblems(
  resource: string,
  stream: string,
  streamAt: string,
  read: TargetRead,
): Promise<string[]> {
  const bytes = await read(resource);
  if (bytes === undefined) return [`${resource} was not written`];
  const problems: string[] = [];
  const header = resourceHeader(bytes);
  if (header?.type !== "AudioStreamRandomizer")
    problems.push(`${resource} is not an AudioStreamRandomizer resource`);
  if (header?.uid === undefined) problems.push(`${resource} has no UID`);
  const path = `res://${streamAt}`;
  const reference = externalReferences(bytes).find((r) => r.path === path);
  if (reference === undefined) {
    problems.push(`${resource} does not reference ${path}`);
    return problems;
  }
  const imported = await read(`${stream}.import`);
  const uid = imported === undefined ? undefined : importUid(imported);
  if (uid !== undefined && reference.uid !== uid)
    problems.push(
      `${resource} references ${path} as ${reference.uid ?? "no UID"}, but its .import gives ${uid}`,
    );
  return problems;
}

async function check(
  audio: ExtensionContext["audio"],
  ctx: PresetContext,
  options: AudioOptions,
  _files: PresetFile[],
  read: TargetRead,
): Promise<string[]> {
  const asset = audioAsset(ctx);
  const { project, stream, randomizer } = layoutOf(asset, options);
  const streamAt = inProject(project, stream, "the stream");
  const problems: string[] = [];
  if (asset.loop !== undefined) {
    const wav = await read(asset.media);
    if (wav === undefined) problems.push(`${asset.media} was not written`);
    else {
      const loop = audio.wavLoop(wav);
      if (loop === undefined)
        problems.push(
          `${asset.media} has no smpl loop, the delivered version loops 0-${asset.loop.end}`,
        );
      else if (loop.start !== asset.loop.begin || loop.end !== asset.loop.end)
        problems.push(
          `${asset.media} smpl loop is ${loop.start}-${loop.end}, the version loops ${asset.loop.begin}-${asset.loop.end}`,
        );
    }
  }
  const imported = await read(`${stream}.import`);
  if (options.format === "ogg") {
    if ((await read(stream)) === undefined) problems.push(`${stream} was not written`);
    if (imported === undefined) problems.push(`${stream}.import was not written`);
    else {
      if (importUid(imported) === undefined) problems.push(`${stream}.import has no UID`);
      problems.push(...oggImportProblems(`${stream}.import`, importParams(imported), asset));
    }
  } else if (imported !== undefined) {
    problems.push(...wavImportProblems(`${stream}.import`, importParams(imported), asset));
  }
  if (randomizer !== undefined)
    problems.push(...(await randomizerProblems(randomizer, stream, streamAt, read)));
  return problems;
}

/** The preset, its options validated with core's zod. */
export function audioPreset(context: ExtensionContext): EnginePreset<AudioOptions> {
  const { z } = context;
  return {
    name: AUDIO_PRESET,
    optionsSchema: z.strictObject({
      project: z.string().default(""),
      format: z.enum(["wav", "ogg"]).default("wav"),
      quality: z.number().min(-1).max(10).optional(),
      ogg: z.string().default(""),
      randomizer: z.string().default(""),
      import: importOptionsSchema(z),
    }),
    write: (ctx, options, read) => write(context.audio, ctx, options, read),
    check: (ctx, options, files, read) => check(context.audio, ctx, options, files, read),
    usage: (ctx, options, read) =>
      godotUsage(ctx, relativePath(options.project, "options.project"), read),
    doctor: (ctx, options, read) =>
      godotDoctor(ctx, relativePath(options.project, "options.project"), read),
  };
}
