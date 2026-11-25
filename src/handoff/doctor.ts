/**
 * The doctor report (issue #483): what each hand-off preset's `doctor` hook finds wrong in the
 * target. Read-only: the target is listed and read, Git is only asked, and nothing is written.
 */
import { execFile, spawn } from "node:child_process";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { realOf } from "../handoff.ts";
import { inGitDir } from "../paths.ts";
import { isInside } from "../settings.ts";
import type { TargetProfile } from "../types.ts";
import { listTarget, usageRead } from "./usage.ts";
import { resolveHandoff } from "./presets/index.ts";
import type { DoctorContext, DoctorFinding, PresetRegistry } from "./presets/index.ts";

const execGit = promisify(execFile);

/** Git told not to write anything, such as a refreshed index. */
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

export interface DoctorInput {
  profile: TargetProfile;
  targetDir: string;
  registry: PresetRegistry;
  stateDir: string;
  /** The settings' directory: like the state directory, never read or listed. */
  configDir: string;
}

export interface DoctorReport {
  findings: Array<DoctorFinding & { presets: string[] }>;
  errors: Array<{ preset: string; error: string }>;
}

/** The findings of every preset of the profile that has a `doctor`, merged and sorted. */
export async function projectDoctor(input: DoctorInput): Promise<DoctorReport> {
  const { profile, registry } = input;
  const presets = resolveHandoff(profile, registry).filter((p) => p.preset.doctor !== undefined);
  const root = resolve(input.targetDir);
  const realTarget = realOf(root);
  const guarded = [input.configDir, input.stateDir].map((dir) => realOf(resolve(dir)));
  const read = usageRead(root, realTarget, guarded);
  const ctx: DoctorContext = {
    profile,
    list: (dir) => listTarget(root, realTarget, dir, guarded),
    tracked: (dir) => tracked(root, realTarget, dir, guarded),
    lfs: (paths) => lfsPaths(root, realTarget, paths),
  };
  const merged = new Map<string, DoctorFinding & { presets: string[] }>();
  const errors: DoctorReport["errors"] = [];
  for (const { preset, options } of presets) {
    try {
      for (const finding of await preset.doctor!(ctx, options, read)) {
        const key = JSON.stringify([
          finding.code,
          finding.path,
          finding.line ?? null,
          finding.problem,
          finding.correction,
        ]);
        const have = merged.get(key);
        if (have === undefined) merged.set(key, { ...finding, presets: [preset.name] });
        else if (!have.presets.includes(preset.name)) have.presets.push(preset.name);
      }
    } catch (error) {
      errors.push({
        preset: preset.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const findings = [...merged.values()].sort(
    (a, b) => order(a.path, b.path) || (a.line ?? 0) - (b.line ?? 0) || order(a.code, b.code),
  );
  return { findings, errors };
}

/** A target-relative path made with `/`, or undefined when it leaves the target or is in `.git`. */
function inTarget(root: string, path: string): string | undefined {
  if (isAbsolute(path)) return undefined;
  const rel = posix.normalize(path.replaceAll("\\", "/") || ".");
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("/") || inGitDir(rel))
    return undefined;
  return relative(root, resolve(root, rel)) === "" && rel !== "." ? undefined : rel;
}

async function tracked(
  root: string,
  realTarget: string,
  dir: string,
  guarded: string[],
): Promise<string[]> {
  const rel = inTarget(root, dir);
  if (rel === undefined) return [];
  const start = realOf(join(root, ...rel.split("/")));
  if (!isInside(start, realTarget) || guarded.some((g) => isInside(start, g))) return [];
  let stdout: string;
  try {
    ({ stdout } = await execGit("git", ["--literal-pathspecs", "ls-files", "-z", "--", rel], {
      cwd: root,
      env: GIT_ENV,
      maxBuffer: 1 << 28,
    }));
  } catch {
    return [];
  }
  return stdout
    .split("\0")
    .filter(
      (p) =>
        p !== "" &&
        !inGitDir(p) &&
        !guarded.some((g) => isInside(realOf(join(root, ...p.split("/"))), g)),
    )
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function lfsPaths(
  root: string,
  realTarget: string,
  paths: readonly string[],
): Promise<string[]> {
  const asked = [
    ...new Set(
      paths.flatMap((p) => {
        const rel = inTarget(root, p);
        return rel === undefined || rel === "." ? [] : [rel];
      }),
    ),
  ];
  if (asked.length === 0 || realTarget === "") return [];
  const out = await new Promise<string>((done) => {
    const child = spawn("git", ["--literal-pathspecs", "check-attr", "-z", "--stdin", "filter"], {
      cwd: root,
      env: GIT_ENV,
    });
    let text = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (text += chunk));
    child.on("error", () => done(""));
    child.on("close", (code) => done(code === 0 ? text : ""));
    child.stdin.on("error", () => {});
    child.stdin.end(asked.join("\0") + "\0");
  });
  const fields = out.split("\0");
  const found: string[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3)
    if (fields[i + 2] === "lfs") found.push(fields[i]!);
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
