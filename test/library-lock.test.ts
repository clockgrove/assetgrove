import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { acquireLibraryLock } from "../src/runs/lock.ts";

const moduleUrl = pathToFileURL(join(import.meta.dirname, "..", "src", "runs", "lock.ts")).href;

function childAcquire(target: string, state: string): string {
  const script =
    `import(${JSON.stringify(moduleUrl)}).then((m) => {` +
    `try { m.acquireLibraryLock(${JSON.stringify(target)}, ${JSON.stringify(state)}); console.log("acquired"); }` +
    `catch (e) { console.log(e.code); } });`;
  return execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }).trim();
}

test("the library lock holds our pid and refuses a second live process", () => {
  const root = mkdtempSync(join(tmpdir(), "library-lock-"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  const state = join(root, "state");
  const lock = acquireLibraryLock(root, state);
  const path = join(root, ".git", "assetgrove", "library.lock");
  assert.equal(lock.path, path);
  assert.equal(readFileSync(path, "utf8").split("\n")[0], String(process.pid));
  assert.equal(childAcquire(root, state), "run_in_progress");
  lock.release();
  assert.equal(existsSync(path), false);
});

test("a dead process's library lock is taken over", () => {
  const root = mkdtempSync(join(tmpdir(), "library-lock-"));
  mkdirSync(join(root, ".git", "assetgrove"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git", "assetgrove", "library.lock"), "2147483646\n");
  const lock = acquireLibraryLock(root, join(root, "state"));
  assert.equal(lock.tookOver, true);
  lock.release();
});

test("a target in no repository locks under the state directory", () => {
  const root = mkdtempSync(join(tmpdir(), "library-lock-"));
  const state = join(root, "state");
  const lock = acquireLibraryLock(root, state);
  assert.ok(lock.path.startsWith(join(state, "library-locks")));
  assert.match(lock.path, /[0-9a-f]{16}\.lock$/);
  assert.equal(existsSync(lock.path), true);
  lock.release();
});

test("outside Git, a library root reached through a symlink takes one lock before and after it is created", () => {
  const top = mkdtempSync(join(tmpdir(), "library-lock-link-"));
  const real = join(top, "real");
  mkdirSync(real);
  symlinkSync(real, join(top, "link"), "junction");
  const root = join(top, "link", "assets", "source");
  const state = join(top, "state");
  const before = acquireLibraryLock(root, state);
  mkdirSync(root, { recursive: true });
  assert.equal(childAcquire(root, state), "run_in_progress");
  before.release();
  const after = acquireLibraryLock(root, state);
  assert.equal(after.path, before.path);
  after.release();
});
