/**
 * The tracked-key guard (design section 4). It runs at MCP server start, at each paid command's
 * start and on the pick and write-families target, and refuses (exit 2 `key_tracked`, naming the
 * file and never the value) when a file Git tracks holds a key. Hand-written: see docs/decisions.md,
 * "The tracked-key scan is hand-written".
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { gitDirSet, keyValue, type Env } from "./env.ts";
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
  /** For an assignment hit, the Git blob id of the content that hit: what a person may acknowledge. */
  blob?: string;
}

/** The configured key variable names: the adapters' defaults and each provider's `keyEnv`. */
export function configuredKeyEnv(settings?: Pick<Settings, "providers"> | undefined): string[] {
  const names = new Set<string>(DEFAULT_KEY_ENV);
  for (const provider of Object.values(settings?.providers ?? {})) {
    if (provider.keyEnv) names.add(provider.keyEnv);
  }
  return [...names];
}

const PLACEHOLDER_WORDS = [
  "your",
  "here",
  "example",
  "placeholder",
  "changeme",
  "replace",
  "redacted",
  "xxxx",
];

/**
 * Whether an assigned value is shaped like a key: a literal of MIN_KEY_VALUE_LENGTH or more
 * characters with no whitespace or brackets, that is not an expression (`os.environ`,
 * `process.env`, `{{`, `${`, a leading `$`) and not an obvious placeholder: one of the whole words
 * `your`, `here`, `example`, `placeholder`, `changeme`, `replace`, `redacted` or `xxxx` between
 * non-alphanumeric separators, one repeated character, or ending in `...`.
 */
export function isAssignedValue(raw: string): boolean {
  let value = raw.trim();
  // A trailing comment, or a value that is only a comment, is not part of the value.
  value = value.replace(/(^|\s)#.*$/, "").trim();
  value = value.replace(/,$/, "").trim();
  const quoted = /^(["'])(.*)\1$/.exec(value);
  if (quoted) value = quoted[2]!.trim();
  if (value.length < MIN_KEY_VALUE_LENGTH) return false;
  if (/\s/.test(value) || /[()[\]{}<>]/.test(value)) return false;
  if (value.startsWith("$") || value.includes("os.environ") || value.includes("process.env"))
    return false;
  if (value.includes("{{") || value.includes("${")) return false;
  if (value.endsWith("...") || value.endsWith("\u2026")) return false;
  // A placeholder word counts only as a whole word between separators (`your-api-key-here`), so a
  // random key that merely contains its letters (`...xHeRe9...`) is still a key.
  const words = value.toLowerCase().split(/[^a-z0-9]+/);
  if (words.some((word) => PLACEHOLDER_WORDS.includes(word) || /^x{4,}$/.test(word))) return false;
  if (/^(.)\1*$/su.test(value)) return false;
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

/** The nearest existing directory at or above `dir`. */
function existingDir(dir: string): string {
  let at = resolve(dir);
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  return at;
}

/**
 * The directory at or above `dir` that holds a `.git` entry (a directory, or a worktree's file);
 * `dir` itself when GIT_DIR is set; undefined outside Git. Git runs from there, not from a
 * deeper directory that Windows cannot enter past 260 characters.
 */
function insideGit(dir: string): string | undefined {
  if (gitDirSet()) return dir;
  let at = dir;
  for (;;) {
    if (existsSync(join(at, ".git"))) return at;
    if (dirname(at) === at) return undefined;
    at = dirname(at);
  }
}

/** A refusal for a repository whose tracked files Git could not list: nothing proves it clean. */
function unscannable(step: string, result: ReturnType<typeof spawnSync>): KeyTrackedError {
  const why = result.error
    ? result.error.message
    : `exit ${result.status ?? result.signal}: ${
        String(result.stderr ?? "")
          .trim()
          .split("\n")[0] ?? ""
      }`;
  return new KeyTrackedError(
    `the tracked-key guard could not read the repository's tracked files (git ${step}, ${why}), so it cannot show that no tracked file holds a key. Make git work in this checkout (installed, and the directory trusted under safe.directory) and run again.`,
    [],
  );
}

/**
 * The Git top level holding `dir` (or its nearest existing ancestor); undefined when no `.git`
 * entry is at or above it. Inside one, a git that cannot answer is a refusal, never a pass.
 */
function topLevel(dir: string): string | undefined {
  const at = insideGit(existingDir(dir));
  if (at === undefined) return undefined;
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: at, encoding: "utf8" });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw unscannable("rev-parse", result);
  }
  return result.stdout.trim();
}

/** One index entry: its path relative to the top level, mode and blob id. */
interface IndexEntry {
  file: string;
  mode: string;
  oid: string;
}

/** Every index entry of the repository at `top` (`git ls-files -z --cached --stage`). */
function trackedFiles(top: string): IndexEntry[] {
  const result = spawnSync("git", ["ls-files", "-z", "--cached", "--stage"], {
    cwd: top,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw unscannable("ls-files", result);
  const entries = new Map<string, IndexEntry>();
  for (const record of result.stdout.toString("utf8").split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, oid] = record.slice(0, tab).split(" ");
    const file = record.slice(tab + 1);
    // A conflicted path has several stages; each blob is read.
    entries.set(`${file}\0${oid}`, { file, mode: mode!, oid: oid! });
  }
  return [...entries.values()];
}

/**
 * The staged content of each regular-file entry whose blob is 4 MB or less, by blob id. The index
 * is what the next commit takes, so a key staged and then edited out of the working file counts.
 */
function stagedBlobs(top: string, entries: IndexEntry[]): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  const oids = [
    ...new Set(entries.filter((e) => e.mode === "100644" || e.mode === "100755").map((e) => e.oid)),
  ];
  if (oids.length === 0) return blobs;
  const check = spawnSync("git", ["cat-file", "--batch-check"], {
    cwd: top,
    input: `${oids.join("\n")}\n`,
    maxBuffer: 256 * 1024 * 1024,
    encoding: "utf8",
  });
  if (check.error || check.status !== 0) throw unscannable("cat-file --batch-check", check);
  const small = check.stdout
    .split("\n")
    .map((line) => line.split(" "))
    .filter(([, type, size]) => type === "blob" && Number(size) <= MAX_SCANNED_BYTES)
    .map(([oid]) => oid!);
  if (small.length === 0) return blobs;
  const batch = spawnSync("git", ["cat-file", "--batch"], {
    cwd: top,
    input: `${small.join("\n")}\n`,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (batch.error || batch.status !== 0) throw unscannable("cat-file --batch", batch);
  const out = batch.stdout;
  let at = 0;
  while (at < out.length) {
    const eol = out.indexOf(0x0a, at);
    if (eol < 0) break;
    const [oid, type, size] = out.subarray(at, eol).toString("utf8").split(" ");
    if (type !== "blob") {
      at = eol + 1;
      continue;
    }
    const length = Number(size);
    blobs.set(oid!, out.subarray(eol + 1, eol + 1 + length));
    at = eol + 1 + length + 1;
  }
  return blobs;
}

/** The working-tree content of a tracked file, unless it is missing, not a file or over 4 MB. */
function workingContent(path: string): Buffer | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_SCANNED_BYTES) return undefined;
    return readFileSync(path);
  } catch {
    return undefined; // Deleted from the working tree: its staged content is still read.
  }
}

/** The Git blob id of `content`, in the hash algorithm of `oidLength` (64 is sha256, else sha1). */
function blobId(content: Buffer, oidLength: number): string {
  return createHash(oidLength === 64 ? "sha256" : "sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");
}

/**
 * The key a file's content holds, by exact value first, then by named assignment unless the
 * content's blob id is acknowledged. The exact-value rule is never acknowledged.
 */
function keyIn(
  content: Buffer,
  file: string,
  values: ReadonlyArray<readonly [string, string]>,
  names: readonly string[],
  acknowledged: ReadonlySet<string>,
  oid: (content: Buffer) => string,
): TrackedKey | undefined {
  if (content.subarray(0, LFS_POINTER.length).equals(LFS_POINTER)) return undefined;
  const valueHit = values.find(([, value]) => content.includes(value));
  if (valueHit) return { file, variable: valueHit[0], rule: "value" };
  const assigned = assignedKeys(content.toString("utf8"), file, names);
  if (assigned.length === 0) return undefined;
  const blob = oid(content);
  if (acknowledged.has(blob)) return undefined;
  return { file, variable: assigned[0]!, rule: "assignment", blob };
}

/**
 * Every tracked file of the repository holding `dir` that holds a key: the exact value (16+
 * characters) of a configured key variable, or a key-shaped literal assigned to one by name unless
 * the file content's blob id is in `acknowledgedBlobs`. LFS
 * pointers and files over 4 MB are skipped. Each file's staged blob and its working-tree content are
 * read. With no `.git` at or above `dir` nothing is tracked; inside one, a git that cannot list
 * or read the tracked files is a `key_tracked` refusal, never a pass.
 */
export function findTrackedKeys(
  dir: string,
  options: { env?: Env; keyEnv?: readonly string[]; acknowledgedBlobs?: readonly string[] } = {},
): TrackedKey[] {
  const names = [...new Set(options.keyEnv ?? DEFAULT_KEY_ENV)];
  const top = topLevel(dir);
  if (top === undefined) return [];
  const values = names
    .map((name) => [name, keyValue(name, options.env)?.trim() ?? ""] as const)
    .filter(([, value]) => value.length >= MIN_KEY_VALUE_LENGTH);
  const acknowledged = new Set((options.acknowledgedBlobs ?? []).map((id) => id.toLowerCase()));
  const entries = trackedFiles(top);
  const staged = stagedBlobs(top, entries);
  const found: TrackedKey[] = [];
  const seen = new Set<string>();
  for (const { file, oid } of entries) {
    if (seen.has(file)) continue;
    // Both the staged content (what the next commit takes) and the working file (what
    // `commit -a` would take) are read.
    const contents = [staged.get(oid), workingContent(join(top, file))];
    for (const content of contents) {
      const hit =
        content && keyIn(content, file, values, names, acknowledged, (c) => blobId(c, oid.length));
      if (hit) {
        found.push(hit);
        seen.add(file);
        break;
      }
    }
  }
  return found;
}

/**
 * Throws `key_tracked` (exit 2) when a tracked file of the repository holding `dir` holds a key,
 * naming each file and variable and never the value.
 */
export function checkTrackedKeys(
  dir: string,
  options: {
    env?: Env;
    settings?: Pick<Settings, "providers"> & Partial<Pick<Settings, "keyGuard">>;
  } = {},
): void {
  const keyEnv = configuredKeyEnv(options.settings);
  registerKeyEnv(keyEnv);
  const found = findTrackedKeys(dir, {
    keyEnv,
    acknowledgedBlobs: options.settings?.keyGuard?.acknowledgedBlobs ?? [],
    ...(options.env && { env: options.env }),
  });
  if (found.length === 0) return;
  const listed = found.map((f) =>
    f.rule === "value"
      ? `${f.file} holds the value of ${f.variable}`
      : `${f.file} assigns a value to ${f.variable} (blob ${f.blob})`,
  );
  const acknowledge = found
    .filter((f) => f.rule === "assignment")
    .map((f) => f.blob)
    .join(" ");
  throw new KeyTrackedError(
    `a tracked file holds a key: ${listed.join("; ")}. Remove the key from the file and from Git history, rotate it, and keep keys in the environment only.${
      acknowledge
        ? ` If an assignment's value is not a live key, after checking that, list its blob id in the developer settings' keyGuard.acknowledgedBlobs (assetgrove settings change --acknowledge-blobs ${acknowledge}); a file's value that matches the key this process holds is never acknowledged.`
        : ""
    }`,
    found.map((f) => f.file),
  );
}
