/**
 * The `godot:sprite-frames` preset (families scope): one SpriteFrames per asset holding every
 * animation family handed off so far, each frame an AtlasTexture region of its family's strip.
 * Godot builds it: the preset lays out a scratch project (src/scratch.ts) with every family's
 * media and the UIDs read from the target as data, runs the pinned Godot headless there through
 * core's tool runner, and returns what Godot saved: the resource, and the `.import` of each
 * source file the target does not have one for yet. An existing `.import` is never returned, so
 * core never touches it, and a replaced resource keeps its UID.
 */
import { posix } from "node:path";
import type {
  EnginePreset,
  ExtensionContext,
  FamiliesContext,
  PresetFile,
  TargetRead,
  ToolResult,
} from "@clockgrove/assetgrove/extension";
import { externalReferences, importUid, resourceHeader } from "./godot-text.ts";
import { errorLines } from "./output.ts";
import {
  GODOT_ARGS,
  INPUT_PATH,
  RESULT_PATH,
  projectFiles,
  type BuildInput,
  type BuildResult,
} from "./scratch.ts";

export const PRESET = "godot:sprite-frames";
export const TOOL = "godot:engine";
/** How long one Godot run may take: an editor start, an import and a save. */
const RUN_TIMEOUT_MS = 300_000;

export interface SpriteFramesOptions {
  /** The Godot project's directory (where `project.godot` is), relative to the target. */
  project: string;
  /** The SpriteFrames, relative to the target, `{assetId}` replaced; inside the project. */
  resource: string;
  /** Whether each animation loops. */
  loop: boolean;
}

/** One problem a Godot run or the check found. */
export interface Problem {
  preset: string;
  problem: string;
  file?: string;
}

/**
 * A run that failed: Godot reported an error, a resource did not load, or Godot left no result.
 * Core reports it as exit 6 `handoff_check_failed`, so nothing is written.
 */
export class GodotRunError extends Error {
  readonly code = "handoff_check_failed";
  readonly problems: Problem[];
  constructor(problems: Problem[]) {
    super(`Godot did not build the resources: ${problems.map((p) => p.problem).join("; ")}`);
    this.name = "GodotRunError";
    this.problems = problems;
  }
}

/** An option or an input the preset cannot use: invalid input (exit 2). */
export class GodotInputError extends Error {
  readonly code = "invalid_input";
  constructor(message: string) {
    super(message);
    this.name = "GodotInputError";
  }
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A `/`-separated relative path, normalised; refused when it is absolute or climbs out. */
function relativePath(path: string, what: string): string {
  const slashed = path.replaceAll("\\", "/");
  const normal = posix.normalize(slashed === "" ? "." : slashed);
  if (posix.isAbsolute(normal) || /^[A-Za-z]:/.test(normal) || normal.split("/").includes(".."))
    throw new GodotInputError(`${what} ${JSON.stringify(path)} must be relative to the target`);
  return normal === "." ? "" : normal;
}

/** The path inside the Godot project of a target-relative path, or a refusal naming it. */
function inProject(project: string, path: string, what: string): string {
  if (project === "") return path;
  if (!path.startsWith(`${project}/`))
    throw new GodotInputError(
      `${what} ${path} is outside the Godot project ${project}/ (options.project); Godot reaches only files under its project`,
    );
  return path.slice(project.length + 1);
}

/** The animation speed in frames per second for a frame duration in milliseconds. */
const speedOf = (durationMs: number | undefined) =>
  durationMs !== undefined && durationMs > 0 ? 1000 / durationMs : 10;

interface Layout {
  project: string;
  /** The resource, relative to the target. */
  resource: string;
}

function layoutOf(ctx: FamiliesContext, options: SpriteFramesOptions): Layout {
  const project = relativePath(options.project, "options.project");
  const resource = relativePath(
    options.resource.replaceAll("{assetId}", ctx.assetId),
    "options.resource",
  );
  if (resource === "" || !resource.endsWith(".tres"))
    throw new GodotInputError(`options.resource ${JSON.stringify(resource)} must end in .tres`);
  inProject(project, resource, "the resource");
  return { project, resource };
}

/** Runs Godot on the scratch project and returns its result, or throws what went wrong. */
async function build(
  ctx: FamiliesContext,
  files: Record<string, Uint8Array | string>,
): Promise<{ result: BuildResult; ran: ToolResult }> {
  if (ctx.run === undefined)
    throw new GodotInputError(`the preset ${PRESET} needs core's tool runner to run Godot`);
  const ran = await ctx.run(TOOL, { args: [...GODOT_ARGS], files, timeoutMs: RUN_TIMEOUT_MS });
  const problems: Problem[] = errorLines(`${ran.stdout}\n${ran.stderr}`).map((line) => ({
    preset: PRESET,
    problem: `Godot: ${line}`,
  }));
  const written = ran.files.find((f) => f.path === RESULT_PATH);
  let result: BuildResult | undefined;
  try {
    result =
      written === undefined ? undefined : (JSON.parse(decode(written.content)) as BuildResult);
  } catch {
    result = undefined;
  }
  if (result === undefined)
    problems.push({ preset: PRESET, problem: "Godot left no result of the build" });
  else if (!result.ok && problems.length === 0)
    for (const error of result.errors ?? [])
      problems.push({ preset: PRESET, problem: `Godot: ${error}` });
  if (ran.exitCode !== 0 && problems.length === 0)
    problems.push({ preset: PRESET, problem: `Godot exited with ${ran.exitCode}` });
  if (problems.length > 0 || result === undefined || !result.ok) throw new GodotRunError(problems);
  return { result, ran };
}

async function write(
  ctx: FamiliesContext,
  options: SpriteFramesOptions,
  read: TargetRead,
): Promise<PresetFile[]> {
  const { project, resource } = layoutOf(ctx, options);
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
    resource: `res://${inProject(project, resource, "the resource")}`,
    ...(uid !== undefined && { uid }),
    frameWidth: ctx.profile.frames.width,
    frameHeight: ctx.profile.frames.height,
    animations,
  };
  files[INPUT_PATH] = JSON.stringify(input, null, 2);

  const { ran } = await build(ctx, files);
  const output = (target: string): Uint8Array => {
    const path = inProject(project, target, "a file");
    const file = ran.files.find((f) => f.path === path);
    if (file === undefined)
      throw new GodotRunError([{ preset: PRESET, problem: `Godot did not write ${path}` }]);
    return file.content;
  };
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
  const { project, resource } = layoutOf(ctx, options);
  const bytes = await read(resource);
  if (bytes === undefined) return [`${resource} was not written`];
  const header = resourceHeader(bytes);
  const problems: string[] = [];
  if (header?.type !== "SpriteFrames") problems.push(`${resource} is not a SpriteFrames resource`);
  if (header?.uid === undefined) problems.push(`${resource} has no UID`);
  const references = externalReferences(bytes);
  for (const family of ctx.families) {
    const media = relativePath(family.media, `the media of ${family.name}`);
    const path = `res://${inProject(project, media, `the media of ${family.name}`)}`;
    const reference = references.find((r) => r.path === path);
    if (reference === undefined) {
      problems.push(`${resource} does not reference ${path} (${family.name})`);
      continue;
    }
    const imported = await read(`${media}.import`);
    const uid = imported === undefined ? undefined : importUid(imported);
    if (uid === undefined) problems.push(`${media}.import is missing or has no UID`);
    else if (reference.uid !== uid)
      problems.push(
        `${resource} references ${path} as ${reference.uid ?? "no UID"}, but its .import gives ${uid}`,
      );
  }
  return problems;
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
    }),
    write,
    check,
  };
}
