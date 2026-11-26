/**
 * Running audio operations and recipes. `runAudioOperation` and `runAudioRecipe` work on items in
 * memory; `transformAudioFiles` reads WAV files, runs a recipe and writes the outputs with their
 * provenance record, as `transformFiles` does for images.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { InputError } from "../errors.ts";
import {
  DIGITAL_SOURCE_TYPES,
  embedDigitalSourceType,
  metadataStep,
  readDigitalSourceType,
  sourceDeclaration,
} from "../metadata.ts";
import type { DigitalSourceType, SourceDeclaration } from "../metadata.ts";
import { sha256 } from "../request.ts";
import { operationSpec } from "../transform/operations.ts";
import { checkStep } from "../transform/run.ts";
import type { Recipe, RecipeStep, TransformStep } from "../transform/types.ts";
import { AUDIO_ENGINE, decodeAudio, encodeWav, frameCount, sampleHash } from "./engine.ts";
import type { AudioItem } from "./engine.ts";
import { AUDIO_IMPLEMENTATIONS } from "./operations.ts";
import type { AudioOperationContext } from "./operations.ts";

export interface AudioRunOptions {
  digitalSourceType?: DigitalSourceType;
}

/**
 * Runs one audio operation over the items and returns the new items and its one provenance step.
 * The items given are not changed.
 */
export async function runAudioOperation(
  items: AudioItem[],
  step: RecipeStep,
  options: AudioRunOptions = {},
): Promise<{ items: AudioItem[]; step: TransformStep }> {
  const spec = operationSpec(step.op);
  const params = checkStep(step);
  const impl = AUDIO_IMPLEMENTATIONS[step.op];
  if (spec?.media !== "audio" || !impl)
    throw new InputError(`${step.op} is an image operation and cannot run on audio`);
  if (step.engine !== undefined && step.engine !== AUDIO_ENGINE.name)
    throw new InputError(`${step.op} runs on "${AUDIO_ENGINE.name}", not "${step.engine}"`);
  const context: AudioOperationContext = {};
  const reports: Record<string, unknown>[] = [];
  const out: AudioItem[] = [];
  for (const item of items) {
    const result = await impl(item, params, context);
    if (result.report) reports.push(result.report);
    for (const output of result.items)
      out.push({
        ...output,
        digitalSourceType:
          output.digitalSourceType ??
          item.digitalSourceType ??
          options.digitalSourceType ??
          DIGITAL_SOURCE_TYPES.undeclared,
      });
  }
  const report =
    reports.length === 0 ? undefined : reports.length === 1 ? reports[0] : { perInput: reports };
  return {
    items: out,
    step: {
      op: step.op,
      params,
      engine: { name: AUDIO_ENGINE.name, version: AUDIO_ENGINE.version },
      inputs: items.map(sampleHash),
      outputs: out.map(sampleHash),
      ...(report !== undefined && { report }),
    },
  };
}

/** Runs a recipe's steps in order over audio items. */
export async function runAudioRecipe(
  recipe: Recipe,
  items: AudioItem[],
  options: AudioRunOptions = {},
): Promise<{ items: AudioItem[]; steps: TransformStep[] }> {
  const steps: TransformStep[] = [];
  let current = items;
  for (const s of recipe.steps) {
    const result = await runAudioOperation(current, s, options);
    current = result.items;
    steps.push(result.step);
  }
  return { items: current, steps };
}

export interface AudioSourceFile {
  digitalSourceType: DigitalSourceType;
  name: string;
  path: string;
  sha256: string;
  mediaType: "audio/wav";
  samples: string;
  decodedBy: { name: string; version: string };
}

export interface AudioOutputFile {
  digitalSourceType: DigitalSourceType;
  name: string;
  path: string;
  sha256: string;
  mediaType: "audio/wav";
  sampleRate: number;
  channels: number;
  frames: number;
  bitDepth: string;
  samples: string;
  encodedBy: { name: string; version: string };
  meta?: Record<string, unknown>;
}

/** The provenance record of an audio transformation: sources, every step, outputs. */
export interface AudioTransformRecord {
  generator: "transform";
  sourceDeclaration?: SourceDeclaration;
  recipe?: { name?: string; description?: string };
  sources: AudioSourceFile[];
  steps: TransformStep[];
  outputs: AudioOutputFile[];
}

export interface TransformAudioFilesOptions extends AudioRunOptions {
  dryRun?: boolean;
  inputName?: string;
  recipe: Recipe;
  inputs: string[];
  /** A `.wav` file path for one output; otherwise a directory. */
  out: string;
}

/** Reads WAV inputs, runs the recipe, writes the WAV outputs and the provenance record. */
export async function transformAudioFiles(options: TransformAudioFilesOptions): Promise<{
  record: AudioTransformRecord;
  provenancePath: string;
  plannedFiles: { path: string; bytes: Uint8Array }[];
}> {
  if (options.inputs.length === 0) throw new InputError("no input audio given");
  if (
    options.inputName !== undefined &&
    (options.inputs.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(options.inputName))
  )
    throw new InputError("inputName requires one input and a safe file stem");
  const sources: AudioSourceFile[] = [];
  const items: AudioItem[] = [];
  const seen = new Set<string>();
  for (const path of options.inputs) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(path));
    } catch (error) {
      throw new InputError(`cannot read ${path}: ${(error as Error).message}`, { cause: error });
    }
    let name = options.inputName ?? basename(path, extname(path));
    for (let n = 2; seen.has(name); n++) name = `${basename(path, extname(path))}-${n}`;
    seen.add(name);
    let item: AudioItem;
    try {
      item = decodeAudio(bytes, name);
    } catch (error) {
      throw new InputError(`cannot decode ${path}: ${(error as Error).message}`, { cause: error });
    }
    const digitalSourceType =
      readDigitalSourceType(bytes, "audio/wav") ??
      options.digitalSourceType ??
      DIGITAL_SOURCE_TYPES.undeclared;
    item.digitalSourceType = digitalSourceType;
    items.push(item);
    sources.push({
      name,
      path,
      sha256: sha256(bytes),
      mediaType: "audio/wav",
      samples: sampleHash(item),
      digitalSourceType,
      decodedBy: { name: AUDIO_ENGINE.name, version: AUDIO_ENGINE.version },
    });
  }

  const { items: results, steps } = await runAudioRecipe(options.recipe, items, options);
  if (results.length === 0) throw new InputError("the recipe produced no output");

  const out = resolve(options.out);
  const isDir = await stat(out).then(
    (s) => s.isDirectory(),
    () => false,
  );
  const single = results.length === 1 && extname(out) !== "" && !isDir;
  if (single && extname(out).toLowerCase() !== ".wav")
    throw new InputError(
      `refused: ${out} names a ${extname(out)} file but the output is audio/wav; use a .wav path`,
    );
  const dir = single ? dirname(out) : out;
  const inputs = new Set(options.inputs.map((p) => resolve(p)));
  const planned = results.map((item) => {
    const path = single ? out : join(dir, `${item.name}.wav`);
    if (inputs.has(path))
      throw new InputError(`refused: ${path} is an input; sources are never overwritten`);
    return { item, path };
  });
  if (new Set(planned.map((p) => p.path)).size !== planned.length)
    throw new InputError("two outputs share a name");
  const provenancePath = single ? `${out}.provenance.json` : join(dir, "provenance.json");
  if (inputs.has(provenancePath)) throw new InputError(`refused: ${provenancePath} is an input`);

  if (!options.dryRun) await mkdir(dir, { recursive: true });
  const plannedFiles: { path: string; bytes: Uint8Array }[] = [];
  const outputs: AudioOutputFile[] = [];
  for (const { item, path } of planned) {
    const digitalSourceType = item.digitalSourceType ?? DIGITAL_SOURCE_TYPES.undeclared;
    const samples = sampleHash(item);
    const bytes = embedDigitalSourceType(encodeWav(item), "audio/wav", digitalSourceType);
    steps.push(metadataStep(digitalSourceType, [samples]));
    plannedFiles.push({ path, bytes });
    if (!options.dryRun) await writeFile(path, bytes);
    const meta = Object.keys(item.meta).length === 0 ? undefined : structuredClone(item.meta);
    outputs.push({
      name: item.name,
      digitalSourceType,
      path,
      sha256: sha256(bytes),
      mediaType: "audio/wav",
      sampleRate: item.sampleRate,
      channels: item.channels.length,
      frames: frameCount(item),
      bitDepth: item.bitDepth,
      samples,
      encodedBy: { name: AUDIO_ENGINE.name, version: AUDIO_ENGINE.version },
      ...(meta !== undefined && { meta }),
    });
  }
  const record: AudioTransformRecord = {
    generator: "transform",
    ...(options.digitalSourceType !== undefined && {
      sourceDeclaration: sourceDeclaration(options.digitalSourceType),
    }),
    ...((options.recipe.name !== undefined || options.recipe.description !== undefined) && {
      recipe: {
        ...(options.recipe.name !== undefined && { name: options.recipe.name }),
        ...(options.recipe.description !== undefined && {
          description: options.recipe.description,
        }),
      },
    }),
    sources,
    steps,
    outputs,
  };
  if (!options.dryRun) await writeFile(provenancePath, `${JSON.stringify(record, null, 2)}\n`);
  return { record, provenancePath, plannedFiles };
}
