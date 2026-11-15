import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SearchError } from "./errors.ts";

const STALE_EMPTY_MS = 10_000;

function lockPath(storeDir: string): string {
  return join(storeDir, "write.lock");
}

export class WriteLock {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }

  async release(): Promise<void> {
    try {
      const text = await retryBusy(() => readFile(this.path, "utf8"));
      if (Number.parseInt(text.trim(), 10) !== process.pid) return;
      await retryBusy(() => unlink(this.path));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}

/**
 * On Windows a file that another handle is creating, reading or deleting refuses an open or an
 * unlink with one of these codes for a few milliseconds. They are contention, not a permission
 * problem, so the operation is tried again.
 */
function busy(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return (
    process.platform === "win32" && (code === "EPERM" || code === "EBUSY" || code === "EACCES")
  );
}

async function retryBusy<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (e) {
      if (!busy(e) || attempt >= 10) throw e;
      await sleep(5 * attempt);
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** The lock's state and the exact text it was judged on. */
async function heldState(
  path: string,
): Promise<{ state: "free" | "held" | "stale"; text?: string }> {
  let text: string;
  try {
    text = await retryBusy(() => readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: "free" };
    // Still busy after the retries: another process is working on the lock, so it counts as held.
    if (busy(e)) return { state: "held" };
    throw e;
  }
  const pid = Number.parseInt(text.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    try {
      const { mtimeMs } = await stat(path);
      return { state: Date.now() - mtimeMs > STALE_EMPTY_MS ? "stale" : "held", text };
    } catch {
      return { state: "free" };
    }
  }
  if (pid === process.pid) return { state: "held", text };
  return { state: alive(pid) ? "held" : "stale", text };
}

/**
 * Removes a stale lock so that only one process can: the remover first takes
 * `write.lock.takeover` by exclusive create, then re-reads the lock and removes it only while it
 * still holds the same dead text. A second process that judged the same lock stale finds either
 * the guard held or, once it is free, the winner's live lock, and removes nothing. A guard left
 * by a process that died inside this window (milliseconds) is cleared after STALE_EMPTY_MS.
 */
async function removeStale(path: string, staleText: string): Promise<void> {
  const guard = `${path}.takeover`;
  let handle;
  try {
    handle = await open(guard, "wx");
  } catch (e) {
    if (busy(e)) return;
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    try {
      const { mtimeMs } = await stat(guard);
      if (Date.now() - mtimeMs > STALE_EMPTY_MS) await unlink(guard);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return;
  }
  try {
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
    handle = undefined;
    const now = await heldState(path);
    if (now.state === "stale" && now.text === staleText) {
      try {
        await retryBusy(() => unlink(path));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT" && !busy(e)) throw e;
      }
    }
  } finally {
    await handle?.close();
    await unlink(guard).catch(() => undefined);
  }
}

export async function tryAcquireWriteLock(storeDir: string): Promise<WriteLock | undefined> {
  await mkdir(storeDir, { recursive: true });
  const path = lockPath(storeDir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await retryBusy(() => open(path, "wx"));
      try {
        await handle.writeFile(`${process.pid}\n`);
      } finally {
        await handle.close();
      }
      return new WriteLock(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" && !busy(e)) throw e;
    }
    const { state, text } = await heldState(path);
    if (state === "held") return undefined;
    if (state === "stale") await removeStale(path, text as string);
  }
  return undefined;
}

export async function acquireWriteLock(
  storeDir: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<WriteLock> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = await tryAcquireWriteLock(storeDir);
    if (lock) return lock;
    if (Date.now() >= deadline) {
      throw new SearchError(
        "store_locked",
        `Another process holds the search store write lock at ${lockPath(storeDir)}.`,
        { details: { path: lockPath(storeDir), timeoutMs } },
      );
    }
    await sleep(pollMs);
  }
}

export async function lockHeldByOther(storeDir: string): Promise<boolean> {
  return (await heldState(lockPath(storeDir))).state === "held";
}
