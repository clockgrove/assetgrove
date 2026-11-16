/**
 * Git and Git LFS for the library (design section 5): the marked `.gitattributes` block init
 * writes inside the library root, and the checks pick makes by asking Git. Nothing here parses
 * `.gitattributes`, runs `git add`, `git commit` or `git lfs install`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { gitDirSet } from "./env.ts";
import { InputError } from "./errors.ts";

export const LFS_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "glb", "ktx2"] as const;
const MARKER = "# BEGIN assetgrove";
export const BLOCK_BEGIN = `${MARKER} (managed block: edits inside are replaced)`;
export const BLOCK_END = "# END assetgrove";

/** The rules inside the marked block, one per line. */
export const BLOCK_RULES: readonly string[] = [
  ...LFS_EXTENSIONS.map((ext) => `*.${ext} filter=lfs diff=lfs merge=lfs -text`),
  "*.md text eol=lf",
  "*.review.json text eol=lf",
  "*.provenance.json text eol=lf",
  "index.md merge=union",
  "log.md merge=union",
  "*.review.json merge=union",
];

export const BLOCK = `${[BLOCK_BEGIN, ...BLOCK_RULES, BLOCK_END].join("\n")}\n`;

/** A target outside a Git work tree (exit 2 `git_required`). */
export class GitRequiredError extends InputError {
  readonly code = "git_required";
  constructor(path: string) {
    super(
      `${path} is not inside a Git work tree; Assetgrove's library lives in a Git repository (run git init)`,
    );
    this.name = "GitRequiredError";
  }
}

/** Media Git would not send to LFS (exit 2 `lfs_required`). */
export class LfsRequiredError extends InputError {
  readonly code = "lfs_required";
  readonly paths: string[];
  constructor(paths: string[]) {
    super(
      `Git does not send ${paths.join(", ")} to LFS (git check-attr filter is not lfs); run init for the library, or add the rule to .gitattributes, before picking`,
    );
    this.name = "LfsRequiredError";
    this.paths = paths;
  }
}

function git(cwd: string, args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

/** The nearest existing directory at or above `path`. */
function existingDir(path: string): string {
  let dir = resolve(path);
  while (!existsSync(dir)) dir = dirname(dir);
  return dir;
}

/**
 * The directory git runs from for `path`: the nearest one at or above it that holds a `.git`
 * entry, so a target deeper than Windows can enter (260 characters) never becomes the cwd; the
 * nearest existing directory when none does (outside Git, or GIT_DIR is set).
 */
function gitCwd(path: string): string {
  const start = existingDir(path);
  if (gitDirSet()) return start;
  for (let at = start; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at;
    if (dirname(at) === at) return start;
  }
}

/** A git that could not be run at all is not "not a work tree": say so. */
function ran(result: ReturnType<typeof git>): ReturnType<typeof git> {
  if (result.error) throw new Error(`could not run git: ${result.error.message}`);
  return result;
}

/** Whether `path` (which may not exist yet) is inside a Git work tree. */
export function insideWorkTree(path: string): boolean {
  const result = ran(git(gitCwd(path), ["rev-parse", "--is-inside-work-tree"]));
  return result.status === 0 && result.stdout.trim() === "true";
}

/** Throws GitRequiredError unless `path` is inside a Git work tree. */
export function requireWorkTree(path: string): void {
  if (!insideWorkTree(path)) throw new GitRequiredError(path);
}

/** The version line of `git lfs version`, or undefined when Git LFS is not installed. */
export function lfsVersion(cwd: string): string | undefined {
  const result = git(cwd, ["lfs", "version"]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * Throws unless Git maps the filter of each of `paths` to lfs: GitRequiredError outside a work
 * tree, else LfsRequiredError. Each path may not exist yet.
 */
export function requireLfsMedia(paths: readonly string[]): void {
  const refused: string[] = [];
  for (const path of paths) {
    const abs = resolve(path);
    const dir = gitCwd(dirname(abs));
    requireWorkTree(dir);
    const result = ran(git(dir, ["check-attr", "filter", "--", abs]));
    if (result.status !== 0) throw new GitRequiredError(abs);
    if (!/: filter: lfs\s*$/.test(result.stdout.trim())) refused.push(abs);
  }
  if (refused.length > 0) throw new LfsRequiredError(refused);
}

/**
 * `text` with the marked block put in: replaced in place when present, else appended after a
 * blank line. Everything outside the block is kept.
 */
export function withBlock(text: string): string {
  const start = text.search(/^# BEGIN assetgrove/m);
  const endAt = start === -1 ? -1 : text.indexOf(BLOCK_END, start);
  if (start !== -1 && endAt !== -1) {
    let end = endAt + BLOCK_END.length;
    if (text[end] === "\r") end += 1;
    if (text[end] === "\n") end += 1;
    return `${text.slice(0, start)}${BLOCK}${text.slice(end)}`;
  }
  if (text === "") return BLOCK;
  return `${text}${text.endsWith("\n") ? "" : "\n"}\n${BLOCK}`;
}

/** Whether the repository's pre-push hook runs Git LFS. */
export function lfsHooksInstalled(cwd: string): boolean {
  const result = git(cwd, ["rev-parse", "--git-path", "hooks/pre-push"]);
  if (result.status !== 0) return false;
  const hook = result.stdout.trim();
  try {
    const path = isAbsolute(hook) ? hook : join(cwd, hook);
    return existsSync(path) && /git[- ]lfs/.test(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

/** The bytes of the LFS objects committed under `dir`, from `git lfs ls-files`; 0 when none. */
export function lfsSize(dir: string): number {
  const prefix = git(dir, ["rev-parse", "--show-prefix"]).stdout.trim();
  const result = git(dir, ["lfs", "ls-files", "--json"]);
  if (result.status !== 0) return 0;
  try {
    const parsed = JSON.parse(result.stdout) as {
      files: Array<{ name: string; size: number }> | null;
    };
    return (parsed.files ?? [])
      .filter((file) => file.name.startsWith(prefix))
      .reduce((sum, file) => sum + file.size, 0);
  } catch {
    return 0;
  }
}
