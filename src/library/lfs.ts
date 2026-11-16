/**
 * Reads media that may be a Git LFS pointer. A pointer counts as present: its oid is compared with
 * the expected sha256 and its bytes come from `.git/lfs/objects` when local. Nothing here runs
 * `git lfs`, fetches, or returns pointer text as media, so reads never touch the network or the
 * work tree.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { InputError } from "../errors.ts";
import { isLfsPointer } from "../request.ts";

export interface LfsPointer {
  oid: string;
  size: number;
}

export type MediaRead =
  | { kind: "file"; bytes: Uint8Array; sha256: string; matches?: boolean }
  | {
      kind: "lfs-object";
      bytes: Uint8Array;
      sha256: string;
      pointer: LfsPointer;
      matches?: boolean;
    }
  | { kind: "lfs-pointer"; pointer: LfsPointer; sha256: string; matches?: boolean };

const VERSION = "version https://git-lfs.github.com/spec/v1";

/** The oid and size of a Git LFS spec v1 pointer file, or undefined when the bytes are anything else. */
export function parseLfsPointer(bytes: Uint8Array): LfsPointer | undefined {
  if (!isLfsPointer(bytes)) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  if (!text.endsWith("\n")) return undefined;
  const lines = text.slice(0, -1).split("\n");
  if (lines[0] !== VERSION) return undefined;
  let oid: string | undefined;
  let size: number | undefined;
  for (const line of lines.slice(1)) {
    const space = line.indexOf(" ");
    if (space < 1) return undefined;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === "oid") {
      const m = /^sha256:([0-9a-f]{64})$/.exec(value);
      if (!m) return undefined;
      oid = m[1];
    } else if (key === "size") {
      if (!/^\d+$/.test(value)) return undefined;
      size = Number(value);
    }
  }
  return oid !== undefined && size !== undefined ? { oid, size } : undefined;
}

function gitDirOf(dotGit: string): string | undefined {
  let stat;
  try {
    stat = statSync(dotGit);
  } catch {
    return undefined;
  }
  let gitDir = dotGit;
  if (stat.isFile()) {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (!m?.[1]) return undefined;
    gitDir = resolve(dirname(dotGit), m[1]);
  }
  const common = join(gitDir, "commondir");
  if (existsSync(common)) {
    const target = readFileSync(common, "utf8").trim();
    if (target) return resolve(gitDir, target);
  }
  return gitDir;
}

/** The git directory that holds `lfs/objects` for `start`, walking up to find `.git`; undefined when there is none. */
export function findGitDir(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const found = gitDirOf(join(dir, ".git"));
    if (found !== undefined) return found;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Where Git LFS keeps the object `oid` inside `gitDir`. */
export function lfsObjectPath(gitDir: string, oid: string): string {
  return join(gitDir, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
}

const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A media file that is not there (or is a folder): told from an invalid one by type, not by wording. */
export class MediaMissingError extends InputError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MediaMissingError";
  }
}

async function readExisting(path: string): Promise<Uint8Array> {
  try {
    return await readFile(path);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "EISDIR"
    ) {
      throw new MediaMissingError(`media file ${path} does not exist`, { cause: error });
    }
    throw error;
  }
}

/**
 * Reads the media at `path`. A Git LFS pointer resolves to its local object when that object's size
 * and hash match the pointer, else stays a pointer with no bytes. `sha256`, when given, is compared
 * with the media hash (the oid for a pointer). Bytes that look like a pointer but fail the strict
 * parse are refused (InputError), so pointer text is never returned as media.
 */
export async function readMedia(
  path: string,
  options: { gitDir?: string; sha256?: string } = {},
): Promise<MediaRead> {
  const abs = isAbsolute(path) ? path : resolve(path);
  const bytes = await readExisting(abs);
  const expected = options.sha256?.toLowerCase();
  const withMatch = <T extends MediaRead>(read: T): T =>
    expected === undefined ? read : { ...read, matches: read.sha256 === expected };

  const pointer = parseLfsPointer(bytes);
  if (!pointer && isLfsPointer(bytes)) {
    throw new InputError(
      `media file ${path} looks like a Git LFS pointer but is not a valid spec v1 pointer`,
    );
  }
  if (!pointer) return withMatch({ kind: "file", bytes, sha256: sha256Of(bytes) });

  const gitDir = options.gitDir ?? findGitDir(dirname(abs));
  if (gitDir !== undefined) {
    const object = await readFile(lfsObjectPath(gitDir, pointer.oid)).catch(() => undefined);
    if (object && object.length === pointer.size && sha256Of(object) === pointer.oid) {
      return withMatch({ kind: "lfs-object", bytes: object, sha256: pointer.oid, pointer });
    }
  }
  return withMatch({ kind: "lfs-pointer", pointer, sha256: pointer.oid });
}
