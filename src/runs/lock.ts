/**
 * A run directory's lock (design section 9): `lock`, created exclusively and holding the pid of
 * the process running the request, with what tells that process apart from a later one with the
 * same pid. A lock held by a live process refuses the run (exit 2 `run_in_progress`); a dead
 * process's lock is taken over.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { uptime } from "node:os";
import { dirname, join, resolve } from "node:path";
import { findGitDir } from "../library/lfs.ts";

export const LOCK_FILE = "lock";

/** A run another live process holds. Exit 2 `run_in_progress`. */
export class RunInProgressError extends Error {
  readonly code = "run_in_progress";
  readonly pid: number;
  readonly runDir: string;
  constructor(runDir: string, pid: number) {
    super(
      `refused: the run ${runDir} is in progress in process ${pid}; repeat the request once it ends` +
        ` (if process ${pid} is not running this request, remove ${join(runDir, LOCK_FILE)} and repeat it)`,
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

/**
 * Who holds a lock. Where the system exposes them (Linux `/proc`), `bootId` and `startTicks` are
 * the boot the holder ran in and its start time in that boot. Elsewhere `startedMs` is when the
 * holder started, known for this process's own lock.
 */
interface Holder {
  pid: number;
  bootId?: string;
  startTicks?: string;
  startedMs?: number;
}

function bootId(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** A process's start in clock ticks since boot (`/proc/<pid>/stat` field 22), where readable. */
function startTicks(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The fields after the command name, which ends at the last ")", start with field 3.
    const ticks = stat
      .slice(stat.lastIndexOf(")") + 2)
      .split(" ")
      .at(22 - 3);
    return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : undefined;
  } catch {
    return undefined;
  }
}

/** What a lock of `pid` records beside the pid. */
function identity(pid: number): Omit<Holder, "pid"> {
  const boot = bootId();
  const ticks = boot === undefined ? undefined : startTicks(pid);
  if (boot !== undefined && ticks !== undefined) return { bootId: boot, startTicks: ticks };
  return pid === process.pid ? { startedMs: Math.floor(Date.now() - process.uptime() * 1000) } : {};
}

function holder(path: string): Holder | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const [first, second] = text.split("\n");
  const pid = Number.parseInt(first?.trim() ?? "", 10);
  if (!Number.isInteger(pid)) return undefined;
  const held: Holder = { pid };
  try {
    const raw = JSON.parse(second ?? "") as Record<string, unknown>;
    if (typeof raw["bootId"] === "string") held.bootId = raw["bootId"];
    if (typeof raw["startTicks"] === "string") held.startTicks = raw["startTicks"];
    if (typeof raw["startedMs"] === "number") held.startedMs = raw["startedMs"];
  } catch {
    // A lock holding only a pid is judged by the pid alone.
  }
  return held;
}

/**
 * How far before the machine's boot, by the wall clock, a holder's start must lie to count as
 * dead: wide, so a clock step on a running machine never ends a live holder's lock.
 */
const BOOT_SLACK_MS = 10 * 60_000;

/**
 * Whether the process that wrote a lock still runs: its pid is alive, and nothing shows the live
 * process with that pid to be a later one. A lock from an earlier boot, or whose holder's start
 * differs from the live process's (a pid reused after a restart), is dead.
 */
function holderAlive(held: Holder): boolean {
  if (!pidAlive(held.pid)) return false;
  const boot = bootId();
  if (held.bootId !== undefined && held.startTicks !== undefined && boot !== undefined) {
    if (boot !== held.bootId) return false;
    const ticks = startTicks(held.pid);
    return ticks === undefined || ticks === held.startTicks;
  }
  if (held.startedMs !== undefined)
    return held.startedMs >= Date.now() - uptime() * 1000 - BOOT_SLACK_MS;
  return true;
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
function live(path: string, held: Holder | undefined, pid: number): boolean {
  if (held === undefined) return false;
  if (held.pid === pid) return heldHere.has(path);
  return holderAlive(held);
}

/** Whether the run directory's lock is held by a live process, by the same rule as the takeover. */
export function runLockLive(runDir: string, pid: number = process.pid): boolean {
  const path = join(runDir, LOCK_FILE);
  return live(path, holder(path), pid);
}

/**
 * Creates `path` exclusively holding `pid` and its identity; false when it already exists. The
 * content goes into a file of this call's own first, which is then linked as `path`, so no reader
 * ever sees the lock empty.
 */
function createExclusive(path: string, pid: number): boolean {
  const temporary = `${path}.${pid}.${randomBytes(8).toString("hex")}`;
  writeFileSync(temporary, `${pid}\n${JSON.stringify(identity(pid))}\n`, { flag: "wx" });
  try {
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Removes a dead takeover guard. It is moved aside under a name only this call uses, and put
 * back when what was moved turns out to be a live guard taken in the meantime.
 */
function clearDeadGuard(guard: string, dead: Holder | undefined, pid: number): void {
  const aside = `${guard}.${pid}.${randomBytes(8).toString("hex")}`;
  try {
    renameSync(guard, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const moved = holder(aside);
  if (moved?.pid !== dead?.pid && live(guard, moved, pid)) {
    try {
      linkSync(aside, guard);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  rmSync(aside, { force: true });
}

/**
 * Takes the lock at `path` for this process, or throws `busy(pid)` when a live process holds it. A
 * lock whose holder is dead or unreadable is taken over by exactly one process: the one that
 * creates the takeover guard `<path>.takeover` exclusively. Only the guard's holder removes a dead
 * lock, and it then creates the lock exclusively again, so two processes repeating the same
 * interrupted request never both run it.
 */
export function acquireLock(
  path: string,
  busy: (pid: number) => Error,
  pid: number = process.pid,
): RunLock {
  mkdirSync(dirname(path), { recursive: true });
  const guard = `${path}.takeover`;
  let tookOver = false;
  for (let attempt = 0; ; attempt++) {
    if (createExclusive(path, pid)) break;
    const held = holder(path);
    if (live(path, held, pid) || attempt >= 8) throw busy(held?.pid ?? -1);
    if (!createExclusive(guard, pid)) {
      // Another process is taking the dead lock over; a guard whose process died is cleared.
      const guardHeld = holder(guard);
      if (live(guard, guardHeld, pid)) throw busy(guardHeld?.pid ?? -1);
      clearDeadGuard(guard, guardHeld, pid);
      continue;
    }
    try {
      // Holding the guard, no other process removes the lock; its owner only removes a live one.
      const now = holder(path);
      if (live(path, now, pid)) throw busy(now?.pid ?? -1);
      rmSync(path, { force: true });
      if (!createExclusive(path, pid)) {
        const fresh = holder(path);
        throw busy(fresh?.pid ?? -1);
      }
      tookOver = true;
    } finally {
      if (holder(guard)?.pid === pid) rmSync(guard, { force: true });
    }
    break;
  }
  heldHere.add(path);
  return {
    path,
    tookOver,
    release() {
      heldHere.delete(path);
      if (holder(path)?.pid === pid) rmSync(path, { force: true });
    },
  };
}

/** Takes the run directory's lock for this process, or throws `RunInProgressError`. */
export function acquireRunLock(runDir: string, pid: number = process.pid): RunLock {
  return acquireLock(join(runDir, LOCK_FILE), (p) => new RunInProgressError(runDir, p), pid);
}

/** Another live process is writing the library. Exit 2 `run_in_progress`. */
export class LibraryInProgressError extends Error {
  readonly code = "run_in_progress";
  readonly pid: number;
  readonly lockPath: string;
  constructor(lockPath: string, pid: number) {
    super(
      `refused: another Assetgrove process (${pid}) is writing the library; repeat the request once it ends` +
        ` (if process ${pid} is not running, remove ${lockPath} and repeat it)`,
    );
    this.name = "LibraryInProgressError";
    this.pid = pid;
    this.lockPath = lockPath;
  }
}

/** The common Git directory of the repository containing `start`; undefined outside one. */
export function gitCommonDir(start: string): string | undefined {
  return findGitDir(start);
}

/** The real path of `path`, or the path resolved when it does not exist yet. */
function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Takes the one library write lock: `assetgrove/library.lock` in the repository's common Git
 * directory, or, for a library in no repository, a file in `stateDir` named for the library root's
 * real path. Every writer passes the library root, so a pick and a review of one library outside
 * Git take the same lock.
 */
export function acquireLibraryLock(
  libraryRoot: string,
  stateDir: string,
  pid: number = process.pid,
): RunLock {
  const common = gitCommonDir(libraryRoot);
  const path =
    common !== undefined
      ? join(common, "assetgrove", "library.lock")
      : join(
          stateDir,
          "library-locks",
          `${createHash("sha256").update(realOrResolved(libraryRoot)).digest("hex").slice(0, 16)}.lock`,
        );
  return acquireLock(path, (p) => new LibraryInProgressError(path, p), pid);
}

/** A lock another live process held for longer than a waiter waits. Exit 2 `run_in_progress`. */
export class LockWaitError extends Error {
  readonly code = "run_in_progress";
  readonly pid: number;
  readonly lockPath: string;
  constructor(lockPath: string, pid: number) {
    super(
      `refused: process ${pid} has held ${lockPath} too long; repeat the request once it ends` +
        ` (if process ${pid} is not running, remove ${lockPath} and repeat it)`,
    );
    this.name = "LockWaitError";
    this.pid = pid;
    this.lockPath = lockPath;
  }
}

/**
 * Takes the lock at `path`, waiting while another holder (in this process or another) has it, for
 * up to `timeoutMs`; then throws `LockWaitError`. For short writes that should queue, not refuse.
 */
export async function waitForLock(path: string, timeoutMs = 30_000): Promise<RunLock> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return acquireLock(path, (pid) => new LockWaitError(path, pid));
    } catch (error) {
      if (!(error instanceof LockWaitError) || Date.now() >= deadline) throw error;
    }
    await new Promise((settle) => setTimeout(settle, 10 + Math.floor(Math.random() * 20)));
  }
}
