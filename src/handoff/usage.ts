/**
 * The replacement preview's usage (issue #469): what each hand-off preset's `usage` hook finds in
 * the target about the asset a pick replaces. Read-only: the target is listed and read, never
 * written, and the presets' cache lives in the state directory.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { InputError } from "../errors.ts";
import { realOf } from "../handoff.ts";
import { inGitDir } from "../paths.ts";
import { isInside } from "../settings.ts";
import type { TargetProfile } from "../types.ts";
import { resolveHandoff } from "./presets/index.ts";
import type {
  PresetRegistry,
  TargetEntry,
  TargetRead,
  UsageCache,
  UsageContext,
  UsageReport,
} from "./presets/index.ts";

const git = promisify(execFile);

/** One preset's usage report, or why it could not give one. */
export interface PresetUsage {
  preset: string;
  report?: UsageReport;
  error?: string;
}

export interface ReplacementUsageInput {
  profile: TargetProfile;
  assetId: string;
  /** The asset's current media, absolute. */
  media: string;
  targetDir: string;
  registry: PresetRegistry;
  stateDir: string;
  /** The settings' directory: like the state directory, never read or listed. */
  configDir: string;
}

const NO_CACHE: UsageCache = { get: async () => undefined, set: async () => {} };

/** The usage of the asset a pick replaces, from every preset of the profile that has a `usage`. */
export async function replacementUsage(input: ReplacementUsageInput): Promise<PresetUsage[]> {
  const { profile, assetId, targetDir, registry, stateDir } = input;
  let presets;
  try {
    presets = resolveHandoff(profile, registry).filter((p) => p.preset.usage !== undefined);
  } catch {
    return [];
  }
  if (presets.length === 0) return [];
  const root = resolve(targetDir);
  const relMedia = relative(root, resolve(input.media));
  if (relMedia === "" || relMedia.startsWith("..") || isAbsolute(relMedia)) return [];
  const realTarget = realOf(root);
  const media = relMedia.split(sep).join("/");
  const revision = await headCommit(root);
  const cacheable = !isInside(realOf(resolve(stateDir)), realTarget);
  const guarded = [input.configDir, stateDir].map((dir) => realOf(resolve(dir)));
  const read = usageRead(root, realTarget, guarded);
  const list = (dir: string) => listTarget(root, realTarget, dir, guarded);
  const out: PresetUsage[] = [];
  for (const { preset, options } of presets) {
    const ctx: UsageContext = {
      profile,
      assetId,
      media,
      list,
      revision,
      cache: cacheable ? fileCache(stateDir, preset.name, realTarget) : NO_CACHE,
    };
    try {
      out.push({ preset: preset.name, report: await preset.usage!(ctx, options, read) });
    } catch (error) {
      out.push({
        preset: preset.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}

async function headCommit(dir: string): Promise<string> {
  try {
    const { stdout } = await git("git", ["rev-parse", "HEAD"], { cwd: dir });
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * A read of the target that refuses `.git`, a path outside it, a path through a link out of it and
 * a path in the settings or state directories, as a hand-off write's read does.
 */
function usageRead(root: string, realTarget: string, guarded: string[]): TargetRead {
  return async (rel) => {
    const full = resolve(root, rel);
    const within = relative(root, full);
    if (within === "" || within.startsWith("..") || isAbsolute(within))
      throw new InputError(`a preset may not read "${rel}": it leaves the target directory`);
    if (inGitDir(within)) throw new InputError(`a preset may not read "${rel}": it is in .git`);
    const real = realOf(full);
    if (real === realTarget || !isInside(real, realTarget))
      throw new InputError(`a preset may not read "${rel}": it leaves the target through a link`);
    if (guarded.some((dir) => isInside(real, dir)))
      throw new InputError(
        `a preset may not read "${rel}": it reaches the Assetgrove settings or state`,
      );
    return readFile(full).then(
      (bytes) => new Uint8Array(bytes),
      () => undefined,
    );
  };
}

async function listTarget(
  root: string,
  realTarget: string,
  dir: string,
  guarded: string[],
): Promise<TargetEntry[]> {
  const rel = posix.normalize(dir.replaceAll("\\", "/") || ".");
  if (isAbsolute(dir) || rel === ".." || rel.startsWith("../") || rel.startsWith("/")) return [];
  const start = rel === "." ? root : join(root, ...rel.split("/"));
  const realStart = realOf(start);
  if (!isInside(realStart, realTarget) || guarded.some((g) => isInside(realStart, g))) return [];
  const found: TargetEntry[] = [];
  const walk = async (abs: string, relDir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const path = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        const sub = join(abs, entry.name);
        if (!guarded.some((g) => isInside(realOf(sub), g))) await walk(sub, path);
      }
      else if (entry.isFile()) {
        try {
          const s = await lstat(join(abs, entry.name));
          found.push({ path, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
        } catch {
          // gone since it was listed
        }
      }
    }
  };
  if (
    rel !== "." &&
    !(await lstat(start).then(
      (s) => s.isDirectory(),
      () => false,
    ))
  )
    return [];
  await walk(start, rel === "." ? "" : rel);
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function fileCache(stateDir: string, preset: string, realTarget: string): UsageCache {
  const file = (key: string) =>
    join(
      stateDir,
      "cache",
      "usage",
      `${createHash("sha256")
        .update(JSON.stringify([preset, realTarget, key]))
        .digest("hex")}.json`,
    );
  return {
    async get(key) {
      try {
        return JSON.parse(await readFile(file(key), "utf8")) as unknown;
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      try {
        const path = file(key);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(value));
      } catch {
        // a cache that cannot be stored is a cache miss next time
      }
    },
  };
}
