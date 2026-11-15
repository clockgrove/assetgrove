/**
 * A run directory's lock (design section 9): `lock`, created exclusively and holding the pid of
 * the process running the request. A lock held by a live process refuses the run (exit 2
 * `run_in_progress`); a dead process's lock is taken over.
 */
import { openSync, readFileSync, renameSync, rmSync, writeFileSync, closeSync } from "node:fs";
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
 * Takes the run directory's lock for this process, or throws `RunInProgressError` when a live
 * process holds it. A lock whose pid is dead or unreadable is replaced.
 */
export function acquireRunLock(runDir: string, pid: number = process.pid): RunLock {
  const path = join(runDir, LOCK_FILE);
  let tookOver = false;
  try {
    const fd = openSync(path, "wx");
    try {
      writeFileSync(fd, `${pid}\n`);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const held = holder(path);
    if (held !== undefined && pidAlive(held)) throw new RunInProgressError(runDir, held);
    // The holder is gone: replace its lock in one rename, then make sure ours is what stands.
    const temporary = `${path}.${pid}.tmp`;
    writeFileSync(temporary, `${pid}\n`);
    renameSync(temporary, path);
    const now = holder(path);
    if (now !== pid) throw new RunInProgressError(runDir, now ?? -1);
    tookOver = true;
  }
  return {
    path,
    tookOver,
    release() {
      if (holder(path) === pid) rmSync(path, { force: true });
    },
  };
}
