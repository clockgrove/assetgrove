/**
 * The library path rule. Every path read from a card, review record or index row must resolve
 * inside the library root, with symlinks resolved, or the read is refused as invalid input, so a
 * shared card cannot point Assetgrove at a file elsewhere.
 */
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { InputError } from "../errors.ts";
import { readRecordPath } from "../paths.ts";

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel !== ".." && !rel.startsWith(`..${posix.sep}`) && !rel.startsWith("..\\") && !isAbsolute(rel)
  );
}

/** `path` with symlinks resolved on its longest existing prefix; missing segments are kept as written. */
function realish(path: string): string {
  const missing: string[] = [];
  let head = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(head), ...missing.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      missing.push(head.slice(parent.length).replace(/^[\\/]+/, ""));
      head = parent;
    }
  }
}

function resolveInside(root: string, base: string, rel: unknown, source: string): string {
  const refuse = () => new InputError(`${source}: path "${String(rel)}" leaves the library root`);
  if (typeof rel !== "string" || rel === "" || rel.includes("\0")) throw refuse();
  readRecordPath(rel, `${source}: path`);
  const firstSlash = rel.indexOf("/");
  const scheme = rel.indexOf(":");
  if (scheme !== -1 && (firstSlash === -1 || scheme < firstSlash)) throw refuse();
  if (posix.isAbsolute(rel) || win32.isAbsolute(rel)) throw refuse();
  const path = resolve(base, rel);
  if (!within(resolve(root), path)) throw refuse();
  if (!within(realish(root), realish(path))) throw refuse();
  return path;
}

/**
 * The absolute path of `rel`, read from a file in `base`, when it lies inside the library `root`;
 * otherwise throws InputError naming `source`, the file and field it was read from.
 */
export function libraryPath(root: string, base: string, rel: string, source: string): string {
  return resolveInside(root, base, rel, source);
}

/** Whether `rel`, read from a file in `base`, resolves inside the library `root`. */
export function insideLibrary(root: string, base: string, rel: string): boolean {
  try {
    resolveInside(root, base, rel, "path");
    return true;
  } catch {
    return false;
  }
}
