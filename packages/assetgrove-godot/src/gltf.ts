/**
 * The `godot:gltf` preset: a `character-3d` asset, or any binary glTF (`.glb`), handed off to a
 * Godot project as the scene Godot imports. As `godot:sprite-frames`, Godot does the work in a
 * scratch project (src/scratch.ts) through core's tool runner: it imports the `.glb`, a fresh
 * source with the scene import options the preset's `import` option names, loads the imported
 * scene and checks it against what the asset declares: every animation family as an animation of
 * the same name, a `Skeleton3D` with the asset's joint count, and no more meshes than declared.
 * A load error or any `ERROR` line fails the hand-off.
 *
 * Core writes the `.glb`; the preset returns only the `.import` Godot made for a source the target
 * has none for. An existing `.import` reaches scratch as data and is never returned, so core never
 * touches it and a replaced `.glb` keeps its UID.
 */
import type {
  EnginePreset,
  ExtensionContext,
  PresetContext,
  PresetFile,
  TargetRead,
} from "@clockgrove/assetgrove/extension";
import { importUid } from "./godot-text.ts";
import { GodotInputError, inProject, relativePath, runGodot, savedFile } from "./run.ts";
import { GODOT_RELEASE } from "./setup.ts";
import { INPUT_PATH, projectFiles, type GltfInput, type ImportOption } from "./scratch.ts";

export const GLTF_PRESET = "godot:gltf";
/** The media type of a binary glTF, as a `character-3d` asset's `output.mediaType` gives it. */
export const GLB_MEDIA_TYPE = "model/gltf-binary";

export interface GltfOptions {
  /** The Godot project's directory (where `project.godot` is), relative to the target. */
  project: string;
  /** Godot scene import options by their `.import` key, applied to a source with no `.import`. */
  import: Record<string, ImportOption>;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The hand-off's scene: what the preset needs of the asset. */
export interface GltfAsset {
  /** The `.glb`, relative to the target, with `/`. */
  media: string;
  /** What the hand-off context declares; a fact it leaves out is read from the file by Godot. */
  declared: GltfInput["declared"];
}

/**
 * The asset's `.glb` and declared facts from the hand-off context: the animation families from
 * `output.clips[].name` and the joint count from `output.bones`, as a `character-3d` asset gives
 * them; clips shaped without a `name` declare no animations, which Godot then reads from the file.
 * Media that is not a binary glTF is refused.
 */
export function gltfAsset(ctx: PresetContext): GltfAsset {
  const output = record(ctx.context["output"]);
  const path = output["path"];
  if (typeof path !== "string" || path === "")
    throw new GodotInputError(`the hand-off names no media path (output.path)`);
  const glb = output["mediaType"] === GLB_MEDIA_TYPE || /\.glb$/i.test(path);
  if (!glb)
    throw new GodotInputError(
      `the preset ${GLTF_PRESET} hands off a binary glTF (.glb, ${GLB_MEDIA_TYPE}), not ${path}${typeof output["mediaType"] === "string" ? ` (${output["mediaType"]})` : ""}`,
    );
  const declared: GltfInput["declared"] = {};
  const clips = output["clips"];
  // A profile's `model3d.handoff.clipFields` may leave `name` out of the clips or rename it; with
  // no clip carrying a `name`, the animation names are read from the file, as with no clips.
  if (Array.isArray(clips) && clips.some((clip) => "name" in record(clip))) {
    const names = clips.map((clip) => record(clip)["name"]);
    if (!names.every((name): name is string => typeof name === "string" && name !== ""))
      throw new GodotInputError(`the hand-off's output.clips has a clip without a name`);
    declared.animations = names;
  }
  const bones = output["bones"];
  if (bones !== undefined) {
    if (typeof bones !== "number" || !Number.isInteger(bones) || bones < 0)
      throw new GodotInputError(`the hand-off's output.bones is not a joint count`);
    declared.joints = bones;
  }
  return { media: relativePath(path, "the scene"), declared };
}

async function write(
  ctx: PresetContext,
  options: GltfOptions,
  read: TargetRead,
): Promise<PresetFile[]> {
  const asset = gltfAsset(ctx);
  const project = relativePath(options.project, "options.project");
  const at = inProject(project, asset.media, "the scene");
  const content = ctx.mediaBytes ?? (await read(asset.media));
  if (content === undefined) throw new GodotInputError(`the scene ${asset.media} cannot be read`);
  const files: Record<string, Uint8Array | string> = { ...projectFiles(), [at]: content };
  // An existing .import keeps its UID and options; it reaches scratch as data only.
  const existing = await read(`${asset.media}.import`);
  if (existing !== undefined) files[`${at}.import`] = existing;
  const input: GltfInput = {
    build: "gltf",
    godot: GODOT_RELEASE.release,
    scene: `res://${at}`,
    fresh: existing === undefined,
    options: options.import,
    declared: asset.declared,
  };
  files[INPUT_PATH] = JSON.stringify(input, null, 2);

  const { ran } = await runGodot(GLTF_PRESET, ctx.run, files);
  if (existing !== undefined) return [];
  const path = `${asset.media}.import`;
  return [{ path, content: savedFile(GLTF_PRESET, ran, project, path) }];
}

/** Reads the written `.import` back: the scene's source has one, with a UID. */
async function check(
  ctx: PresetContext,
  options: GltfOptions,
  _files: PresetFile[],
  read: TargetRead,
): Promise<string[]> {
  const asset = gltfAsset(ctx);
  inProject(relativePath(options.project, "options.project"), asset.media, "the scene");
  const imported = await read(`${asset.media}.import`);
  if (imported === undefined) return [`${asset.media}.import was not written`];
  return importUid(imported) === undefined ? [`${asset.media}.import has no UID`] : [];
}

/** The preset, its options validated with core's zod. */
export function gltfPreset(context: ExtensionContext): EnginePreset<GltfOptions> {
  const { z } = context;
  return {
    name: GLTF_PRESET,
    optionsSchema: z.strictObject({
      project: z.string().default(""),
      import: z
        .record(z.string().min(1), z.union([z.string(), z.number(), z.boolean()]))
        .default({}),
    }),
    write,
    check,
  };
}
