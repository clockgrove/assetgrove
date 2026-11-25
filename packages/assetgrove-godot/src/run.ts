/**
 * What every preset of the pack shares: the tool it runs, the errors a run ends in, the rule for
 * paths in the target, one Godot run in scratch and the read-back of a written resource's header
 * and references.
 */
import { posix } from "node:path";
import type { TargetRead, ToolResult, ToolRunner } from "@clockgrove/assetgrove/extension";
import { externalReferences, importUid, resourceHeader } from "./godot-text.ts";
import { errorLines } from "./output.ts";
import { GODOT_ARGS, RESULT_PATH, type BuildResult } from "./scratch.ts";

export const TOOL = "godot:engine";
/** How long one Godot run may take: an editor start, an import and a save. */
const RUN_TIMEOUT_MS = 300_000;

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

export const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A `/`-separated relative path, normalised; refused when it is absolute or climbs out. */
export function relativePath(path: string, what: string): string {
  const slashed = path.replaceAll("\\", "/");
  const normal = posix.normalize(slashed === "" ? "." : slashed);
  if (posix.isAbsolute(normal) || /^[A-Za-z]:/.test(normal) || normal.split("/").includes(".."))
    throw new GodotInputError(`${what} ${JSON.stringify(path)} must be relative to the target`);
  return normal === "." ? "" : normal;
}

/** The path inside the Godot project of a target-relative path, or a refusal naming it. */
export function inProject(project: string, path: string, what: string): string {
  if (project === "") return path;
  if (!path.startsWith(`${project}/`))
    throw new GodotInputError(
      `${what} ${path} is outside the Godot project ${project}/ (options.project); Godot reaches only files under its project`,
    );
  return path.slice(project.length + 1);
}

/** Where a preset's project and resource are, both relative to the target. */
export interface Layout {
  project: string;
  /** The resource, relative to the target. */
  resource: string;
}

/** The project and the `.tres` resource of a preset's options, `{assetId}` replaced. */
export function layoutOf(assetId: string, options: { project: string; resource: string }): Layout {
  const project = relativePath(options.project, "options.project");
  const resource = relativePath(
    options.resource.replaceAll("{assetId}", assetId),
    "options.resource",
  );
  if (resource === "" || !resource.endsWith(".tres"))
    throw new GodotInputError(`options.resource ${JSON.stringify(resource)} must end in .tres`);
  inProject(project, resource, "the resource");
  return { project, resource };
}

/** Runs Godot on the scratch project and returns its result, or throws what went wrong. */
export async function runGodot(
  preset: string,
  run: ToolRunner | undefined,
  files: Record<string, Uint8Array | string>,
): Promise<{ result: BuildResult; ran: ToolResult }> {
  if (run === undefined)
    throw new GodotInputError(`the preset ${preset} needs core's tool runner to run Godot`);
  const ran = await run(TOOL, { args: [...GODOT_ARGS], files, timeoutMs: RUN_TIMEOUT_MS });
  const problems: Problem[] = errorLines(`${ran.stdout}\n${ran.stderr}`).map((line) => ({
    preset,
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
  if (result === undefined) problems.push({ preset, problem: "Godot left no result of the build" });
  else if (!result.ok && problems.length === 0)
    for (const error of result.errors ?? []) problems.push({ preset, problem: `Godot: ${error}` });
  if (ran.exitCode !== 0 && problems.length === 0)
    problems.push({ preset, problem: `Godot exited with ${ran.exitCode}` });
  if (problems.length > 0 || result === undefined || !result.ok) throw new GodotRunError(problems);
  return { result, ran };
}

/**
 * A file Godot left in scratch, by its target path, or a failed run naming it. The tool runner
 * returns only files that are new or changed, so a file the pack passed in (`passedIn`) that
 * Godot saved byte for byte as it was is that content.
 */
export function savedFile(
  preset: string,
  ran: ToolResult,
  project: string,
  target: string,
  passedIn?: Uint8Array | string,
): Uint8Array | string {
  const path = inProject(project, target, "a file");
  const file = ran.files.find((f) => f.path === path);
  if (file === undefined && passedIn !== undefined) return passedIn;
  if (file === undefined)
    throw new GodotRunError([{ preset, problem: `Godot did not write ${path}` }]);
  return file.content;
}

/**
 * Reads a written resource back as text: of `type`, with a UID, referencing each media file (by
 * its target path and what to call it) by the UID its `.import` gives it.
 */
export async function resourceProblems(
  type: string,
  project: string,
  resource: string,
  media: Array<{ path: string; name: string }>,
  read: TargetRead,
): Promise<string[]> {
  const bytes = await read(resource);
  if (bytes === undefined) return [`${resource} was not written`];
  const header = resourceHeader(bytes);
  const problems: string[] = [];
  if (header?.type !== type) problems.push(`${resource} is not a ${type} resource`);
  if (header?.uid === undefined) problems.push(`${resource} has no UID`);
  const references = externalReferences(bytes);
  for (const { path: target, name } of media) {
    const path = `res://${inProject(project, target, `the media of ${name}`)}`;
    const reference = references.find((r) => r.path === path);
    if (reference === undefined) {
      problems.push(`${resource} does not reference ${path} (${name})`);
      continue;
    }
    const imported = await read(`${target}.import`);
    const uid = imported === undefined ? undefined : importUid(imported);
    if (uid === undefined) problems.push(`${target}.import is missing or has no UID`);
    else if (reference.uid !== uid)
      problems.push(
        `${resource} references ${path} as ${reference.uid ?? "no UID"}, but its .import gives ${uid}`,
      );
  }
  return problems;
}
