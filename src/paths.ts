/**
 * Portable paths (design section 14). Relative paths Assetgrove records, in run records and JSON
 * output, use `/` on every OS, and readers accept `/` only. A write set holding two paths that
 * differ only by case is refused before anything is written, on every OS, because a
 * case-insensitive file system (the default on macOS and Windows) would write both to one file.
 * Assetgrove's own file I/O goes through `ioPath`, so it works past 260 characters on Windows.
 */
import { isAbsolute, posix, relative, resolve, toNamespacedPath } from "node:path";
import { InputError } from "./errors.ts";

/** A relative path with every separator as `/`. */
export function recordPath(path: string): string {
  return path.replaceAll("\\", "/");
}

/** `path` relative to `root`, with `/` separators. */
export function recordRelative(root: string, path: string): string {
  return recordPath(relative(root, path));
}

/**
 * A path read from a record: relative, `/`-separated and inside the directory it is relative to.
 * Anything else is refused as invalid input.
 */
export function readRecordPath(path: string, what = "recorded path"): string {
  if (
    path === "" ||
    path.includes("\\") ||
    isAbsolute(path) ||
    posix.isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    posix.normalize(path).split("/").includes("..")
  ) {
    throw new InputError(`${what} "${path}" must be a relative path with "/" separators`);
  }
  return path;
}

/**
 * Refuses, as invalid input, a set of paths in which two differ only by case. Called before the
 * first write, so nothing is written.
 */
export function refuseCaseCollisions(paths: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const normal = recordPath(path);
    const key = normal.toLowerCase();
    const earlier = seen.get(key);
    if (earlier !== undefined && earlier !== normal) {
      throw new InputError(
        `"${earlier}" and "${normal}" differ only by case and would be one file on a case-insensitive file system`,
      );
    }
    seen.set(key, normal);
  }
}

/**
 * The path Assetgrove's own file I/O uses: absolute and, on Windows, namespaced (`\\?\`), so reads
 * and writes work past 260 characters. Unchanged elsewhere.
 */
export function ioPath(path: string): string {
  return toNamespacedPath(resolve(path));
}
