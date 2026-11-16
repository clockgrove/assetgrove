/**
 * The undo journal of a write that must leave every file as it was when it fails (`library adopt`,
 * docs/library.md): each file is read before it is first written, then written through any
 * symbolic link to its real path, and `restore` puts back each file written: its earlier bytes and
 * permission bits, its removal (with the folders made for it) when it was new, or the dangling
 * symbolic link it was.
 */
import {
  chmod,
  lstat,
  readFile,
  readlink,
  realpath,
  rm,
  rmdir,
  stat,
  symlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { writeAtomic } from "./write.ts";

interface Snapshot {
  /** The path the write named. */
  path: string;
  /** The real path the write goes to, through any symbolic link. */
  real: string;
  /** The earlier bytes and permission bits, or undefined when the file was not there. */
  before?: { bytes: Uint8Array; mode: number };
  /** The target of a dangling symbolic link at `path`, which a write replaces and `restore` remakes. */
  link?: string;
  /** The folders a write of a new file makes, deepest first. */
  made: string[];
  /** Whether a write reached the file. */
  written: boolean;
}

/** Whether an error says the file is absent, not that it could not be read. */
function absent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The real path of `path`: through every link, or its nearest existing folder's joined with the rest. */
async function realOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!absent(error)) throw error;
    // A dangling link is written at its own path.
    if (
      await lstat(path).then(
        () => true,
        () => false,
      )
    )
      return path;
    const parent = dirname(path);
    return parent === path ? path : join(await realOf(parent), basename(path));
  }
}

/** The folders between `folder` and its nearest existing ancestor, deepest first. */
async function missingFolders(folder: string): Promise<string[]> {
  const made: string[] = [];
  for (let at = folder; ; at = dirname(at)) {
    try {
      await stat(at);
      return made;
    } catch (error) {
      if (!absent(error) || dirname(at) === at) return made;
      made.push(at);
    }
  }
}

/** Why a file could not be put back, for the error that names it. */
function reason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code ?? (error instanceof Error ? error.message : String(error));
}

export class WriteJournal {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly order: Snapshot[] = [];

  /**
   * Reads `path` as it is before any write: its bytes and permission bits, or that it is absent.
   * Any other read error (a file that cannot be read, a folder) throws, so nothing is written.
   */
  async snapshot(path: string): Promise<void> {
    await this.take(path);
  }

  private async take(path: string): Promise<Snapshot> {
    const known = this.snapshots.get(path);
    if (known) return known;
    const real = await realOf(path);
    let before: Snapshot["before"];
    try {
      const bytes = new Uint8Array(await readFile(real));
      before = { bytes, mode: (await stat(real)).mode & 0o7777 };
    } catch (error) {
      if (!absent(error)) throw error;
    }
    let link: string | undefined;
    if (before === undefined && real === path) {
      // A dangling link: the write renames a file over it, so its target is kept to remake it.
      link = await lstat(path).then(
        (stats) => (stats.isSymbolicLink() ? readlink(path) : undefined),
        (error: unknown) => {
          if (absent(error)) return undefined;
          throw error;
        },
      );
    }
    const made = before === undefined ? await missingFolders(dirname(real)) : [];
    const snapshot: Snapshot = {
      path,
      real,
      ...(before && { before }),
      ...(link !== undefined && { link }),
      made,
      written: false,
    };
    this.snapshots.set(path, snapshot);
    return snapshot;
  }

  /** Writes `content` to `path`'s real path (a link stays a link), read first when it was not. */
  async write(path: string, content: string | Uint8Array): Promise<void> {
    const snapshot = await this.take(path);
    if (!this.order.includes(snapshot)) this.order.push(snapshot);
    // writeAtomic renames over the file last, so a write that throws left the file as it was.
    await writeAtomic(snapshot.real, content);
    snapshot.written = true;
  }

  /**
   * Puts back every file written, the last first, and goes on past one it cannot put back: each
   * holds its earlier bytes and permission bits again, or is removed with the folders made for it.
   * The paths (with the reason) it could not put back.
   */
  async restore(): Promise<string[]> {
    const failed: string[] = [];
    for (const snapshot of [...this.order].reverse()) {
      try {
        if (snapshot.link !== undefined) {
          if (snapshot.written) {
            await rm(snapshot.real, { force: true });
            await symlink(snapshot.link, snapshot.real);
          }
        } else if (snapshot.before === undefined) {
          if (snapshot.written) await rm(snapshot.real, { force: true });
          for (const folder of snapshot.made) {
            // A folder something else now holds a file in stays.
            await rmdir(folder).catch(() => undefined);
          }
        } else if (snapshot.written) {
          await writeAtomic(snapshot.real, snapshot.before.bytes);
          if (process.platform !== "win32") await chmod(snapshot.real, snapshot.before.mode);
        }
      } catch (error) {
        failed.push(`${snapshot.path} (${reason(error)})`);
      }
    }
    this.order.length = 0;
    return failed;
  }
}
