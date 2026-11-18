/**
 * A pack's tools (docs/extensions.md#tools): the programs a pack declares (`Extension.tools`) and
 * runs only through the `run` its preset's context holds. Each run is identified by bytes: the
 * sha256 of the executable (at the path the pack's settings hold, never a profile's), of every file
 * the argv names, wherever it lives, and the argv itself, relative to the scratch directory; the
 * approval's project is the game project. Nothing runs before the approval (src/approvals.ts) holds,
 * not even `--version`. A tool runs in a scratch directory core makes outside the project, without
 * any key variable, from the data the pack passes in: target files reach it only as that data. Its
 * outputs are the files it leaves there, which the preset returns for core's usual path checks.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CommandRefusedError,
  identityOf,
  projectOf,
  requireApproval,
  type ApprovalGate,
  type ApprovalMethod,
  type CommandIdentity,
} from "../approvals.ts";
import { InputError } from "../errors.ts";
import { extensionOf } from "../extensions/errors.ts";
import type { RegisteredTool } from "../extensions/registry.ts";
import { keyFreeEnv, redact } from "../redact.ts";

/** A tool run as the hand-off records it beside the files its preset wrote. */
export interface ToolStep {
  kind: "tool";
  /** The tool id, `<name>:<id>`. */
  tool: string;
  /** The approval's hash: of the tool id, argv, the scratch cwd and every hashed file. */
  hash: string;
  method: ApprovalMethod;
}

/** What a pack passes one run. */
export interface ToolRunOptions {
  /** The arguments after the executable, relative to the scratch directory. */
  args: string[];
  /**
   * Files written into scratch before the run, by `/`-separated path relative to it: the only way
   * target data reaches a tool.
   */
  files?: Record<string, Uint8Array | string>;
  /** How long the tool may run; 10 minutes when absent. */
  timeoutMs?: number;
}

/** A file the tool left in scratch, new or changed from what the pack passed in. */
export interface ToolOutputFile {
  /** `/`-separated, relative to scratch. */
  path: string;
  content: Uint8Array;
}

export interface ToolResult {
  exitCode: number;
  /** Redacted. */
  stdout: string;
  /** Redacted. */
  stderr: string;
  files: ToolOutputFile[];
  step: ToolStep;
}

/** Runs a declared tool of the pack; refused for any id the pack does not declare. */
export type ToolRunner = (tool: string, options: ToolRunOptions) => Promise<ToolResult>;

/** What a runner is bound to. */
export interface ToolScope {
  /** The extension name of the pack whose code runs (its preset's prefix). */
  pack: string | undefined;
  /** Every tool the loaded packs declare. */
  tools: ReadonlyMap<string, RegisteredTool> | undefined;
  gate: ApprovalGate;
  /** The game project's directory: the approval's project, and where scratch never is. */
  projectDir: string;
  /** Receives each run's step once it is approved. */
  onStep?: (step: ToolStep) => void;
}

const TIMEOUT_MS = 600_000;
const MAX_BUFFER = 64 * 1024 * 1024;
/** The cwd a tool identity records: scratch is a new directory each run. */
export const SCRATCH_CWD = "<scratch>";

const toPosix = (path: string) => path.split(sep).join("/");
const sha256Hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The runner for the pack `scope.pack`: only that pack's declared tools run. */
export function toolRunner(scope: ToolScope): ToolRunner {
  return async (tool, options) => {
    const declared = scope.tools?.get(tool);
    if (declared === undefined || scope.pack === undefined || declared.pack !== scope.pack) {
      throw new CommandRefusedError(
        `the tool ${JSON.stringify(tool)} is not one ${scope.pack === undefined ? "this code" : `pack "${scope.pack}"`} declares; a pack runs only the tools its extension lists under tools`,
      );
    }
    return runTool(declared, options, scope);
  };
}

/** A runner that refuses every tool, for code that runs no program (the conformance suite). */
export function refusingToolRunner(why: string): ToolRunner {
  return (tool) => Promise.reject(new CommandRefusedError(`the tool ${tool} is refused: ${why}`));
}

/** The runner a preset's context holds: its own pack's tools, in the hand-off's project. */
export function presetToolRunner(presetName: string, scope: Omit<ToolScope, "pack">): ToolRunner {
  return toolRunner({ ...scope, pack: extensionOf(presetName) });
}

/**
 * The executable a tool's settings name: an absolute path to a file, by its real path. Refused
 * (exit 2 `command_refused`) otherwise, and on Windows when it is a `.cmd` or `.bat` shim.
 */
export function toolExecutable(tool: RegisteredTool, platform = process.platform): string {
  const where = `extensionSettings["${tool.package}"].${tool.setting}`;
  const value = tool.settings[tool.setting];
  if (typeof value !== "string" || value === "" || !isAbsolute(value))
    throw new CommandRefusedError(
      `the tool ${tool.id} runs the executable at ${where} in the developer settings, which must be an absolute path; got ${JSON.stringify(value ?? null)}`,
    );
  if (!isFile(value))
    throw new CommandRefusedError(
      `the tool ${tool.id}'s executable ${value} (${where}) is not a file`,
    );
  const real = realpathSync.native(value);
  if (platform === "win32" && /\.(cmd|bat)$/i.test(real))
    throw new CommandRefusedError(
      `the tool ${tool.id}'s executable ${real} is a .cmd or .bat shim, which runs through a shell; name the program itself`,
    );
  return real;
}

/**
 * The identity of one run: kind `tool`, the tool id, argv `[executable, ...args]` with the args as
 * given (relative to scratch), cwd `<scratch>`, and the sha256 of the executable and of every
 * argument that names a regular file: inside scratch by its `/` path there, elsewhere by its real
 * absolute path. Its project is the game project. Reads bytes only; runs nothing.
 */
export function toolIdentity(input: {
  tool: string;
  executable: string;
  args: readonly string[];
  scratch: string;
  projectDir: string;
}): CommandIdentity {
  const scratch = realpathSync.native(input.scratch);
  const files: Record<string, string> = {};
  const hash = (path: string) => {
    const real = realpathSync.native(path);
    const key = isInside(real, scratch) ? toPosix(relative(scratch, real)) : toPosix(real);
    files[key] = sha256Hex(readFileSync(real));
  };
  hash(input.executable);
  for (const arg of input.args) {
    if (arg === "") continue;
    const path = isAbsolute(arg) ? arg : resolve(scratch, arg);
    if (isFile(path)) hash(path);
  }
  return identityOf(
    {
      kind: "tool",
      tool: input.tool,
      argv: [toPosix(input.executable), ...input.args],
      cwd: SCRATCH_CWD,
      files,
    },
    projectOf(input.projectDir),
  );
}

/** A scratch-relative path a pack names for an input: `/`-separated, no `..`, not absolute. */
function scratchPath(scratch: string, path: string): string {
  const parts = path.split("/");
  if (
    path === "" ||
    isAbsolute(path) ||
    path.includes("\\") ||
    parts.some((p) => p === "" || p === "." || p === "..")
  )
    throw new InputError(
      `a tool input path must be "/"-separated and relative to scratch, without "." or ".."; got ${JSON.stringify(path)}`,
    );
  return join(scratch, ...parts);
}

/** Every regular file under `dir` (links and other entries skipped), by `/` path relative to it. */
async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listFiles(join(dir, entry.name), rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

function execute(
  program: string,
  args: string[],
  cwd: string,
  timeout: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    execFile(
      program,
      args,
      { cwd, env: keyFreeEnv(), timeout, maxBuffer: MAX_BUFFER, windowsHide: true, shell: false },
      (error, stdout, stderr) => {
        if (error === null) return done({ exitCode: 0, stdout, stderr });
        const code = (error as { code?: unknown }).code;
        if (typeof code === "number" && !(error as { killed?: boolean }).killed)
          return done({ exitCode: code, stdout, stderr });
        fail(
          new InputError(redact(`the tool ${program} did not finish: ${error.message}`), {
            cause: error,
          }),
        );
      },
    );
  });
}

/**
 * Runs one declared tool: makes scratch outside the project, writes the pack's inputs into it,
 * builds the run's identity, requires its approval, runs it there with the key-free environment,
 * reads back the files it left and removes scratch.
 */
export async function runTool(
  tool: RegisteredTool,
  options: ToolRunOptions,
  scope: Pick<ToolScope, "gate" | "projectDir" | "onStep">,
): Promise<ToolResult> {
  if (!Array.isArray(options.args) || !options.args.every((a) => typeof a === "string"))
    throw new InputError(`the args of tool ${tool.id} must be a list of strings`);
  const executable = toolExecutable(tool);
  const project = projectOf(scope.projectDir);
  const scratch = realpathSync.native(await mkdtemp(join(tmpdir(), "assetgrove-tool-")));
  try {
    if (isInside(scratch, project))
      throw new CommandRefusedError(
        `the scratch directory ${scratch} is inside the game project ${project}; a tool never runs there (set TMPDIR outside the project)`,
      );
    const inputs = new Map<string, string>();
    for (const [path, content] of Object.entries(options.files ?? {})) {
      const full = scratchPath(scratch, path);
      const bytes = typeof content === "string" ? Buffer.from(content) : content;
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, bytes);
      inputs.set(path, sha256Hex(bytes));
    }
    const identity = toolIdentity({
      tool: tool.id,
      executable,
      args: options.args,
      scratch,
      projectDir: project,
    });
    const approval = await requireApproval(identity, scope.gate);
    const step: ToolStep = {
      kind: "tool",
      tool: tool.id,
      hash: approval.hash,
      method: approval.method,
    };
    scope.onStep?.(step);
    const ran = await execute(executable, options.args, scratch, options.timeoutMs ?? TIMEOUT_MS);
    const files: ToolOutputFile[] = [];
    for (const path of await listFiles(scratch)) {
      const content = new Uint8Array(await readFile(join(scratch, ...path.split("/"))));
      if (inputs.get(path) === sha256Hex(content)) continue;
      files.push({ path, content });
    }
    return {
      exitCode: ran.exitCode,
      stdout: redact(ran.stdout),
      stderr: redact(ran.stderr),
      files,
      step,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
