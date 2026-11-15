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
      const text = await readFile(this.path, "utf8");
      if (Number.parseInt(text.trim(), 10) !== process.pid) return;
      await unlink(this.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
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

/** True when the lock file exists and is not stale. */
async function heldState(path: string): Promise<"free" | "held" | "stale"> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "free";
    throw e;
  }
  const pid = Number.parseInt(text.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    try {
      const { mtimeMs } = await stat(path);
      return Date.now() - mtimeMs > STALE_EMPTY_MS ? "stale" : "held";
    } catch {
      return "free";
    }
  }
  if (pid === process.pid) return "held";
  return alive(pid) ? "held" : "stale";
}

export async function tryAcquireWriteLock(storeDir: string): Promise<WriteLock | undefined> {
  await mkdir(storeDir, { recursive: true });
  const path = lockPath(storeDir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(`${process.pid}\n`);
      } finally {
        await handle.close();
      }
      return new WriteLock(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const state = await heldState(path);
    if (state === "held") return undefined;
    if (state === "stale") {
      try {
        await unlink(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
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
  return (await heldState(lockPath(storeDir))) === "held";
}
