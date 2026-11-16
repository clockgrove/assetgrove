/**
 * A target repository for tests that pick or run init: a Git work tree whose root .gitattributes
 * carries the library's rules, so Git sends media to LFS (design section 5).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BLOCK } from "../../src/gitlfs.ts";

/** Makes `dir` a Git work tree with the library's rules at its root, and returns `dir`. */
export function gitTarget(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  writeFileSync(join(dir, ".gitattributes"), BLOCK);
  return dir;
}

/** Makes `dir` a Git work tree with no rules, so LFS is not mapped. */
export function bareGitTarget(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}
