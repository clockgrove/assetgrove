/**
 * A run directory's lock (design section 9): `lock`, created exclusively and holding the pid of
 * the process running the request. A lock held by a live process refuses the run (exit 2
 * `run_in_progress`); a dead process's lock is taken over.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const LOCK_FILE = "lock";

/** A run another live process holds. Exit 2 `run_in_progress`. */
export class RunInProgressError extends Error {
  readonly code = "run_in_progress";
  readonly pid: number;
  readonly runDir: string;
  constructor(runDir: string, pid: number) {
    super(
      `refused: the run ${runDir} is in progress in process ${pid}; repeat the request once it ends`,
    );
    this.name = "RunInProgressError";
    this.pid = pid;
    this.runDir = runDir;
  }
}

/** Whether a process with this pid is alive (one this user cannot signal counts as alive). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function holder(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** A held lock; `release` removes it if this process still holds it. */
export interface RunLock {
  readonly path: string;
  /** True when a dead process's lock was taken over. */
  readonly tookOver: boolean;
  release(): void;
}

/**
 * The lock files this process holds. A lock that names this process's own pid but is not in this
 * set was left by an earlier process that had the same pid (a restarted container, say): it is dead.
 */
const heldHere = new Set<string>();

/** Whether the holder `held` of the lock at `path` is a live process other than a dead namesake. */
function live(path: string, held: number | undefined, pid: number): boolean {
  if (held === undefined) return false;
  if (held === pid) return heldHere.has(path);
  return pidAlive(held);
}

/** Whether the run directory's lock is held by a live process, by the same rule as the takeover. */
export function runLockLive(runDir: string, pid: number = process.pid): boolean {
  const path = join(runDir, LOCK_FILE);
  return live(path, holder(path), pid);
}

/** Creates `path` exclusively holding `pid`; false when it already exists. */
function createExclusive(path: string, pid: number): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeFileSync(fd, `${pid}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Removes a dead takeover guard. It is moved aside under a name only this call uses, and put
 * back when what was moved turns out to be a live guard taken in the meantime.
 */
function clearDeadGuard(guard: string, dead: number | undefined, pid: number): void {
  const aside = `${guard}.${pid}.${randomBytes(8).toString("hex")}`;
  try {
    renameSync(guard, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const moved = holder(aside);
  if (moved !== dead && live(guard, moved, pid)) {
    try {
      linkSync(aside, guard);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  rmSync(aside, { force: true });
}

/**
 * Takes the run directory's lock for this process, or throws `RunInProgressError` when a live
 * process holds it. A lock whose pid is dead or unreadable is taken over by exactly one process:
 * the one that creates the takeover guard `lock.takeover` exclusively. Only the guard's holder
 * removes a dead lock, and it then creates `lock` exclusively again, so two processes repeating
 * the same interrupted request never both run it.
 */
export function acquireRunLock(runDir: string, pid: number = process.pid): RunLock {
  const path = join(runDir, LOCK_FILE);
  const guard = `${path}.takeover`;
  let tookOver = false;
  for (let attempt = 0; ; attempt++) {
    if (createExclusive(path, pid)) break;
    const held = holder(path);
    if (live(path, held, pid) || attempt >= 8) throw new RunInProgressError(runDir, held ?? -1);
    if (!createExclusive(guard, pid)) {
      // Another process is taking the dead lock over; a guard whose process died is cleared.
      const guardHeld = holder(guard);
      if (live(guard, guardHeld, pid)) throw new RunInProgressError(runDir, guardHeld ?? -1);
      clearDeadGuard(guard, guardHeld, pid);
      continue;
    }
    try {
      // Holding the guard, no other process removes `lock`; its owner only removes a live one.
      const now = holder(path);
      if (live(path, now, pid)) throw new RunInProgressError(runDir, now ?? -1);
      rmSync(path, { force: true });
      if (!createExclusive(path, pid)) {
        const fresh = holder(path);
        throw new RunInProgressError(runDir, fresh ?? -1);
      }
      tookOver = true;
    } finally {
      if (holder(guard) === pid) rmSync(guard, { force: true });
    }
    break;
  }
  heldHere.add(path);
  return {
    path,
    tookOver,
    release() {
      heldHere.delete(path);
      if (holder(path) === pid) rmSync(path, { force: true });
    },
  };
}
