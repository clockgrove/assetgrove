/**
 * The `godot:sprite-frames` preset (families scope): one SpriteFrames per asset holding every
 * animation family handed off so far, each frame an AtlasTexture region of its family's strip.
 * Godot builds it: the preset lays out a scratch project (src/scratch.ts) with every family's
 * media and the UIDs read from the target as data, runs the pinned Godot headless there through
 * core's tool runner, and returns what Godot saved: the resource, and the `.import` of each
 * source file the target does not have one for yet. An existing `.import` is never returned, so
 * core never touches it, and a replaced resource keeps its UID. An existing resource is loaded
 * with every file it references and merged into: only the animations named after handed-off
 * families change, and a family animation the developer edited is a conflict, reported before
 * anything is written.
 */
import type {
  EnginePreset,
  ExtensionContext,
  FamiliesContext,
  PresetFile,
  TargetRead,
} from "@clockgrove/assetgrove/extension";
import { resourceHeader } from "./godot-text.ts";
import { dependencies } from "./references.ts";
import {
  GodotInputError,
  inProject,
  layoutOf,
  relativePath,
  resourceProblems,
  runGodot,
  savedFile,
} from "./run.ts";
import { GODOT_RELEASE } from "./setup.ts";
import { godotDoctor } from "./doctor.ts";
import { godotUsage } from "./usage.ts";
import {
  INPUT_PATH,
  importOptionsSchema,
  projectFiles,
  type BuildInput,
  type ImportOption,
} from "./scratch.ts";
import { textureFilterWarning } from "./texture-filter.ts";

export const PRESET = "godot:sprite-frames";

export interface SpriteFramesOptions {
  /** The Godot project's directory (where `project.godot` is), relative to the target. */
  project: string;
  /** The SpriteFrames, relative to the target, `{assetId}` replaced; inside the project. */
  resource: string;
  /** Whether each animation loops. */
  loop: boolean;
  /**
   * Godot texture import options by their `.import` key (`compress/mode`, `mipmaps/generate`),
   * applied to the `.import` of each source file the target has none for. An existing `.import`
   * is never changed.
   */
  import: Record<string, ImportOption>;
}

/** A PNG's width in pixels, from its `IHDR` chunk, or undefined when the bytes are no PNG. */
function pngWidth(bytes: Uint8Array | string): number | undefined {
  if (typeof bytes === "string" || bytes.length < 24) return undefined;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (signature.some((byte, i) => bytes[i] !== byte)) return undefined;
  if (new TextDecoder().decode(bytes.subarray(12, 16)) !== "IHDR") return undefined;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16);
}

/** The animation speed in frames per second for a frame duration in milliseconds. */
const speedOf = (durationMs: number | undefined) =>
  durationMs !== undefined && durationMs > 0 ? 1000 / durationMs : 10;

async function write(
  ctx: FamiliesContext,
  options: SpriteFramesOptions,
  read: TargetRead,
): Promise<PresetFile[]> {
  const { project, resource } = layoutOf(ctx.assetId, options);
  const files: Record<string, Uint8Array | string> = { ...projectFiles() };
  const fresh: string[] = [];
  const animations: BuildInput["animations"] = [];
  for (const family of ctx.families) {
    const media = relativePath(family.media, `the media of ${family.name}`);
    const at = inProject(project, media, `the media of ${family.name}`);
    const content = family.content ?? (await read(media));
    if (content === undefined)
      throw new GodotInputError(`the media of ${family.name} (${media}) cannot be read`);
    files[at] = content;
    // An existing .import keeps its UID and options; it reaches scratch as data only.
    const imported = await read(`${media}.import`);
    if (imported === undefined) fresh.push(media);
    else files[`${at}.import`] = imported;
    // The strip the target holds now is the one the preset last wrote: its frame count is what a
    // resource from before the record is compared with, so removed frames are a conflict.
    const previous = family.content === undefined ? undefined : await read(media);
    const width = previous === undefined ? undefined : pngWidth(previous);
    const previousFrames =
      width === undefined ? undefined : Math.floor(width / ctx.profile.frames.width);
    animations.push({
      name: family.name,
      texture: `res://${at}`,
      speed: speedOf(ctx.profile.frames.durationMs),
      loop: options.loop,
      ...(previousFrames !== undefined && previousFrames > 0 && { previousFrames }),
    });
  }
  const resourceAt = inProject(project, resource, "the resource");
  const before = await read(resource);
  const uid = before === undefined ? undefined : resourceHeader(before)?.uid;
  const imports = animations.map((animation) => animation.texture);
  if (before !== undefined) {
    // The families' strips stay this hand-off's bytes: the target's older ones are never loaded.
    files[resourceAt] = before;
    const seen = new Set([resourceAt]);
    for (const animation of animations) {
      const at = animation.texture.slice("res://".length);
      seen.add(at);
      seen.add(`${at}.import`);
    }
    imports.push(...(await dependencies(project, resourceAt, before, read, files, seen)));
  }
  const input: BuildInput = {
    godot: GODOT_RELEASE.release,
    resource: `res://${resourceAt}`,
    ...(before !== undefined && { existing: true, imports }),
    fresh: fresh.map((media) => `res://${inProject(project, media, "the media")}`),
    options: options.import,
    ...(uid !== undefined && { uid }),
    frameWidth: ctx.profile.frames.width,
    frameHeight: ctx.profile.frames.height,
    animations,
  };
  files[INPUT_PATH] = JSON.stringify(input, null, 2);

  const { ran } = await runGodot(PRESET, ctx.run, files);
  const output = (target: string) => savedFile(PRESET, ran, project, target);
  return [
    // Godot saves it in scratch; an unchanged one comes back as passed in.
    { path: resource, content: savedFile(PRESET, ran, project, resource, before) },
    ...fresh.map((media) => ({ path: `${media}.import`, content: output(`${media}.import`) })),
  ];
}

/**
 * Reads the written resource back: a SpriteFrames with a UID that references each family's
 * media by the UID its `.import` gives it.
 */
async function check(
  ctx: FamiliesContext,
  options: SpriteFramesOptions,
  _files: PresetFile[],
  read: TargetRead,
): Promise<string[]> {
  const { project, resource } = layoutOf(ctx.assetId, options);
  return resourceProblems(
    "SpriteFrames",
    project,
    resource,
    ctx.families.map((family) => ({
      path: relativePath(family.media, `the media of ${family.name}`),
      name: family.name,
    })),
    read,
  );
}

/** The preset, its options validated with core's zod. */
export function spriteFramesPreset(context: ExtensionContext): EnginePreset<SpriteFramesOptions> {
  const { z } = context;
  return {
    name: PRESET,
    scope: "families",
    optionsSchema: z.strictObject({
      project: z.string().default(""),
      resource: z.string().min(1).default("{assetId}.tres"),
      loop: z.boolean().default(true),
      import: importOptionsSchema(z),
    }),
    write,
    check,
    warnings: (ctx, options, read) =>
      textureFilterWarning(ctx.profile, relativePath(options.project, "options.project"), read),
    usage: (ctx, options, read) =>
      godotUsage(ctx, relativePath(options.project, "options.project"), read),
    doctor: (ctx, options, read) =>
      godotDoctor(ctx, relativePath(options.project, "options.project"), read),
  };
}
