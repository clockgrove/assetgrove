/**
 * Path rules for every OS (design section 14). Relative paths in records and JSON output use `/`,
 * and readers accept `/` only. A set of writes that differ only by case, or a written path segment
 * holding `:`, is refused as invalid input before anything is written, so a run behaves the same
 * on case-insensitive file systems and on Windows, where `:` names an alternate data stream.
 * Long paths need nothing here: on Windows, Node's fs namespaces absolute paths itself.
 */
import { posix, relative, sep } from "node:path";
import { InputError } from "./errors.ts";

/** `rel` as records and JSON output carry it: `/`-separated. */
export function recordPath(rel: string): string {
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/** `path` relative to `root`, as a record path. */
export function relativeRecordPath(root: string, path: string): string {
  return recordPath(relative(root, path));
}

/** A relative path read from a record: `/`-separated only. */
export function readRecordPath(rel: string, what = "record path"): string {
  if (rel.includes("\\")) {
    throw new InputError(`${what} "${rel}" must use "/" separators`);
  }
  return rel;
}

/**
 * `name` as one file-name segment: lower-case letters, digits and hyphens, every other run of
 * characters (`:` and `/` included) one hyphen. Core asset kinds pass unchanged; `ext:tile`
 * becomes `ext-tile`; a name with nothing left becomes `kind`.
 */
export function safeSegment(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "kind"
  );
}

/**
 * Refuses, before anything is written, a set of relative paths in which two differ only by case or
 * a segment holds `:`.
 */
export function checkWrites(rels: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const rel of rels) {
    const normal = posix.normalize(recordPath(rel));
    const colon = normal.split("/").find((segment) => segment.includes(":"));
    if (colon !== undefined) {
      throw new InputError(`written path "${normal}" has ":" in "${colon}"`);
    }
    const key = normal.toLowerCase();
    const other = seen.get(key);
    if (other !== undefined && other !== normal) {
      throw new InputError(`written paths "${other}" and "${normal}" differ only by case`);
    }
    seen.set(key, normal);
  }
}
