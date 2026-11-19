import { statSync } from "node:fs";
import { join } from "node:path";

/** Git directories have a HEAD even before the first commit. Leave .git files to their callers
 * to resolve, so a broken worktree link still fails closed where Git must scan it. */
export function isGitMarker(path: string): boolean {
  try {
    const entry = statSync(path);
    return entry.isFile() || (entry.isDirectory() && statSync(join(path, "HEAD")).isFile());
  } catch {
    return false;
  }
}
