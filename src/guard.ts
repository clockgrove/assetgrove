/**
 * The tracked-key guard (design section 4). It runs at MCP server start, at each paid command's
 * start and on the pick and write-families target, and refuses (exit 2 `key_tracked`, naming the
 * file and never the value) when a file Git tracks holds a key. Hand-written: see docs/decisions.md,
 * "The tracked-key scan is hand-written".
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import type { Env } from "./env.ts";
import { InputError } from "./errors.ts";
import { DEFAULT_KEY_ENV, registerKeyEnv } from "./redact.ts";
import type { Settings } from "./settings.ts";

/** Tracked files larger than this are not read. */
export const MAX_SCANNED_BYTES = 4 * 1024 * 1024;

/** A tracked file's exact match counts only for values at least this long. */
export const MIN_KEY_VALUE_LENGTH = 16;

const LFS_POINTER = Buffer.from("version https://git-lfs.github.com/spec/");

/** A key in a tracked file, with the code `key_tracked` (exit 2). */
export class KeyTrackedError extends InputError {
  readonly code = "key_tracked";
  /** Each offending file, relative to the repository's top level. */
  readonly files: string[];

  constructor(message: string, files: string[]) {
    super(message);
    this.name = "KeyTrackedError";
    this.files = files;
  }
}

/** One tracked file holding a key: the file and the variable, never the value. */
export interface TrackedKey {
  file: string;
  variable: string;
  rule: "value" | "assignment";
}

/** The configured key variable names: the adapters' defaults and each provider's `keyEnv`. */
export function configuredKeyEnv(settings?: Pick<Settings, "providers">): string[] {
  const names = new Set<string>(DEFAULT_KEY_ENV);
  for (const provider of Object.values(settings?.providers ?? {})) {
    if (provider.keyEnv) names.add(provider.keyEnv);
  }
  return [...names];
}

/**
 * Whether an assigned value is a key: not empty, not empty quotes, not a variable reference
 * (`$NAME`, `${...}`, `${{ ... }}`) and not a placeholder (only dots, or `<...>`).
 */
export function isAssignedValue(raw: string): boolean {
  let value = raw.trim();
  // A trailing comment, or a value that is only a comment, is not part of the value.
  value = value.replace(/(^|\s)#.*$/, "").trim();
  value = value.replace(/,$/, "").trim();
  const quoted = /^(["'])(.*)\1$/.exec(value);
  if (quoted) value = quoted[2]!.trim();
  if (value === "") return false;
  if (value.startsWith("$")) return false;
  if (/^\.+$/.test(value) || /^<[^<>]*>$/.test(value)) return false;
  return true;
}

/** The key variables a file's text assigns a non-empty value to. */
export function assignedKeys(text: string, file: string, names: readonly string[]): string[] {
  const yaml = [".yml", ".yaml"].includes(extname(file).toLowerCase());
  const found: string[] = [];
  for (const name of names) {
    if (!text.includes(name)) continue;
    const patterns = [
      // NAME=value and export NAME=value, at the start of a line.
      new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=(.*)$`, "gm"),
      // A JSON member "NAME": "value", anywhere in a line.
      new RegExp(`"${name}"\\s*:\\s*("(?:[^"\\\\\\n]|\\\\.)*")`, "g"),
      // A YAML member NAME: value, at the start of a line of a YAML file.
      ...(yaml
        ? [new RegExp(`^[ \\t]*(?:-[ \\t]+)?(["']?)${name}\\1[ \\t]*:(?![^\\s])(.*)$`, "gm")]
        : []),
    ];
    const hit = patterns.some((pattern) =>
      [...text.matchAll(pattern)].some((m) => isAssignedValue(m[m.length - 1] ?? "")),
    );
    if (hit) found.push(name);
  }
  return found;
}

/** The Git top level holding `dir` (or its nearest existing ancestor); undefined outside Git. */
function topLevel(dir: string): string | undefined {
  let at = resolve(dir);
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: at, encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return undefined;
  return result.stdout.trim();
}

/** Every tracked file of the repository at `top`, relative to it. */
function trackedFiles(top: string): string[] {
  const result = spawnSync("git", ["ls-files", "-z", "--cached"], {
    cwd: top,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) return [];
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

/**
 * Every tracked file of the repository holding `dir` that holds a key: the exact value (16+
 * characters) of a configured key variable, or a non-empty value assigned to one by name. LFS
 * pointers and files over 4 MB are skipped. Outside a Git repository nothing is tracked.
 */
export function findTrackedKeys(
  dir: string,
  options: { env?: Env; keyEnv?: readonly string[] } = {},
): TrackedKey[] {
  const env = options.env ?? process.env;
  const names = [...new Set(options.keyEnv ?? DEFAULT_KEY_ENV)];
  const top = topLevel(dir);
  if (top === undefined) return [];
  const values = names
    .map((name) => [name, env[name]?.trim() ?? ""] as const)
    .filter(([, value]) => value.length >= MIN_KEY_VALUE_LENGTH);
  const found: TrackedKey[] = [];
  for (const file of trackedFiles(top)) {
    const path = join(top, file);
    let content: Buffer;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > MAX_SCANNED_BYTES) continue;
      content = readFileSync(path);
    } catch {
      continue; // Deleted from the working tree: nothing to read.
    }
    if (content.subarray(0, LFS_POINTER.length).equals(LFS_POINTER)) continue;
    const valueHit = values.find(([, value]) => content.includes(value));
    if (valueHit) {
      found.push({ file, variable: valueHit[0], rule: "value" });
      continue;
    }
    const assigned = assignedKeys(content.toString("utf8"), file, names);
    if (assigned.length > 0) found.push({ file, variable: assigned[0]!, rule: "assignment" });
  }
  return found;
}

/**
 * Throws `key_tracked` (exit 2) when a tracked file of the repository holding `dir` holds a key,
 * naming each file and variable and never the value.
 */
export function checkTrackedKeys(
  dir: string,
  options: { env?: Env; settings?: Pick<Settings, "providers"> } = {},
): void {
  const keyEnv = configuredKeyEnv(options.settings);
  registerKeyEnv(keyEnv);
  const found = findTrackedKeys(dir, { keyEnv, ...(options.env && { env: options.env }) });
  if (found.length === 0) return;
  const listed = found.map((f) =>
    f.rule === "value"
      ? `${f.file} holds the value of ${f.variable}`
      : `${f.file} assigns a value to ${f.variable}`,
  );
  throw new KeyTrackedError(
    `a tracked file holds a key: ${listed.join("; ")}. Remove the key from the file and from Git history, rotate it, and keep keys in the environment only.`,
    found.map((f) => f.file),
  );
}
