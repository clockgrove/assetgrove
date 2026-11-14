/**
 * Portable paths (design section 14). Relative paths in records and JSON output use '/', whatever
 * the OS writes; readers accept '/' only, which node:path also takes on Windows. A set of writes
 * whose paths differ only by case is refused before anything is written, on every OS, because a
 * case-insensitive file system (macOS, Windows) would make the second write replace the first. No
 * file Assetgrove writes has ':' in its name: Windows refuses it, and macOS shows it as '/'.
 *
 * Long paths need nothing here: on Windows, node:fs namespaces every absolute path (`\\?\`), so
 * Assetgrove's own file I/O works past 260 characters.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { InputError } from "./errors.ts";

/** `path` with the OS separator replaced by '/': the form records and JSON output hold. */
export function recordPath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** `to` relative to `from`, in record form. */
export function relativeRecordPath(from: string, to: string): string {
  return recordPath(relative(from, to));
}

/**
 * Refuses, with an InputError (exit 2 `invalid_input`), a set of files to write under `root` when
 * two of them differ only by case, or when a path segment below `root` has ':' in it. Call before
 * the first write.
 */
export function checkWriteSet(root: string, paths: readonly string[]): void {
  const base = resolve(root);
  const seen = new Map<string, string>();
  for (const path of paths) {
    const rel = recordPath(isAbsolute(path) ? relative(base, path) : path);
    for (const segment of rel.split("/")) {
      if (segment.includes(":")) {
        throw new InputError(`the file name "${rel}" has ':' in it, which Windows refuses`);
      }
    }
    const key = rel.toLowerCase();
    const earlier = seen.get(key);
    if (earlier !== undefined && earlier !== rel) {
      throw new InputError(
        `"${earlier}" and "${rel}" differ only by case; a case-insensitive file system would keep one`,
      );
    }
    seen.set(key, rel);
  }
}

/** Checks the set (see `checkWriteSet`), then writes each file, creating its directory. */
export async function writeFiles(
  root: string,
  writes: ReadonlyArray<readonly [path: string, content: Uint8Array | string]>,
): Promise<void> {
  checkWriteSet(
    root,
    writes.map(([path]) => path),
  );
  for (const [path, content] of writes) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}
