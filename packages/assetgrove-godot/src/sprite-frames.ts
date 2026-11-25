/**
 * The `godot:sprite-frames` preset (families scope): one SpriteFrames per asset holding every
 * animation family handed off so far, each frame an AtlasTexture region of its family's strip.
 * Godot builds it: the preset lays out a scratch project (src/scratch.ts) with every family's
 * media and the UIDs read from the target as data, runs the pinned Godot headless there through
 * core's tool runner, and returns what Godot saved: the resource, and the `.import` of each
 * source file the target does not have one for yet. An existing `.import` is never returned, so
 * core never touches it, and a replaced resource keeps its UID.
 */
import type {
  EnginePreset,
  ExtensionContext,
  FamiliesContext,
  PresetFile,
  TargetRead,
} from "@clockgrove/assetgrove/extension";
import { resourceHeader } from "./godot-text.ts";
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
    const existing = await read(`${media}.import`);
    if (existing === undefined) fresh.push(media);
    else files[`${at}.import`] = existing;
    animations.push({
      name: family.name,
      texture: `res://${at}`,
      speed: speedOf(ctx.profile.frames.durationMs),
      loop: options.loop,
    });
  }
  const before = await read(resource);
  const uid = before === undefined ? undefined : resourceHeader(before)?.uid;
  const input: BuildInput = {
    godot: GODOT_RELEASE.release,
    resource: `res://${inProject(project, resource, "the resource")}`,
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
    { path: resource, content: output(resource) },
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
  };
}
