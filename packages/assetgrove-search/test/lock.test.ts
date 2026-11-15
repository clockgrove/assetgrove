import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireWriteLock, lockHeldByOther, tryAcquireWriteLock } from "../src/lock.ts";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ag-lock-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a held lock blocks a second acquire until released", () =>
  withDir(async (dir) => {
    const first = await tryAcquireWriteLock(join(dir, "store"));
    assert.ok(first);
    assert.equal(await readFile(first.path, "utf8"), `${process.pid}\n`);
    assert.equal(await tryAcquireWriteLock(join(dir, "store")), undefined);
    assert.equal(await lockHeldByOther(join(dir, "store")), true);
    await first.release();
    assert.equal(await lockHeldByOther(join(dir, "store")), false);
    const again = await tryAcquireWriteLock(join(dir, "store"));
    assert.ok(again);
    await again.release();
  }));

test("a lock with a dead pid is taken over", () =>
  withDir(async (dir) => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "write.lock"), `${dead}\n`);
    const lock = await tryAcquireWriteLock(dir);
    assert.ok(lock);
    assert.equal(await readFile(lock.path, "utf8"), `${process.pid}\n`);
    await lock.release();
  }));

test("racing takeovers of a dead pid's lock leave exactly one holder", () =>
  withDir(async (dir) => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    for (let round = 0; round < 20; round++) {
      await writeFile(join(dir, "write.lock"), `${dead}\n`);
      const got = (
        await Promise.all(Array.from({ length: 8 }, () => tryAcquireWriteLock(dir)))
      ).filter((l) => l !== undefined);
      assert.equal(got.length, 1, `round ${round}: ${got.length} holders`);
      await got[0]!.release();
    }
  }));

test("a fresh empty lock file counts as held", () =>
  withDir(async (dir) => {
    await writeFile(join(dir, "write.lock"), "");
    assert.equal(await tryAcquireWriteLock(dir), undefined);
  }));

test("acquireWriteLock waits for release and times out otherwise", () =>
  withDir(async (dir) => {
    const first = await tryAcquireWriteLock(dir);
    assert.ok(first);
    const waiting = acquireWriteLock(dir, { pollMs: 10 });
    setTimeout(() => void first.release(), 60);
    const second = await waiting;
    await assert.rejects(acquireWriteLock(dir, { timeoutMs: 50, pollMs: 10 }), {
      code: "store_locked",
    });
    await second.release();
  }));
