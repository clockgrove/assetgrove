/**
 * A pack's setup (`Extension.setup`, docs/extensions.md#setup): `assetgrove extensions setup
 * <name>` hands it a `SetupContext` whose `download` is the only way it fetches a file. Every
 * download is pinned to a version and a sha256 or sha512 the pack ships, and checked before the file is used.
 */
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { InputError, ProviderError } from "../errors.ts";
import type { SearchSettings } from "../settings.ts";

/** One file a pack's setup downloads, pinned to a version and a sha256 or sha512 the pack ships. */
export interface PinnedDownload {
  /** Where the file is fetched from, tried in order when a host fails; a hash mismatch stops. */
  urls: string[];
  /** The version the hash pins (a release, a commit); never empty. */
  version: string;
  /** The file's sha256, 64 lower-case hex. Exactly one of `sha256` and `sha512` is given. */
  sha256?: string;
  /** The file's sha512, 128 lower-case hex. Exactly one of `sha256` and `sha512` is given. */
  sha512?: string;
  /** Where it lands, `/`-separated, relative to `SetupContext.dir`. */
  path: string;
}

/** What `assetgrove extensions setup <name>` hands the pack's `setup`. */
export interface SetupContext {
  /** The developer settings' state directory. */
  stateDir: string;
  /** Where downloads land: `<stateDir>/models`. */
  dir: string;
  /** The settings' search block, defaults filled (the search package reads its embedder). */
  search: SearchSettings;
  /**
   * Downloads one pinned file to `dir`/`path` and returns its absolute path. A file already there
   * with the pinned hash (sha256 or sha512) is not fetched again. The bytes are hashed before the file is moved into
   * place; a mismatch deletes the file and fails (exit 4 `provider_error`, `hash_mismatch`).
   */
  download(file: PinnedDownload): Promise<string>;
  /** One line to stderr, prefixed with the pack's name. */
  log(message: string): void;
}

export interface PinnedDownloadOptions {
  fetch?: typeof fetch;
  /** How long a host may send no byte before it is given up; default 60 seconds. */
  stallMs?: number;
  log?: (message: string) => void;
}

function validate(file: PinnedDownload): void {
  const bad = (why: string): never => {
    throw new InputError(`pinned download ${JSON.stringify(file.path)}: ${why}`);
  };
  if (!Array.isArray(file.urls) || file.urls.length === 0) bad("urls must be a non-empty list");
  for (const url of file.urls) {
    let protocol = "";
    try {
      protocol = new URL(url).protocol;
    } catch {
      /* reported below */
    }
    if (protocol !== "http:" && protocol !== "https:") bad(`${String(url)} is not an http(s) URL`);
  }
  if (typeof file.version !== "string" || file.version.trim() === "")
    bad("version must be a non-empty string");
  if (file.sha256 !== undefined && file.sha512 !== undefined)
    bad("give exactly one of sha256 and sha512, not both");
  if (file.sha256 === undefined && file.sha512 === undefined)
    bad("give exactly one of sha256 and sha512");
  if (file.sha512 !== undefined) {
    if (typeof file.sha512 !== "string" || !/^[0-9a-f]{128}$/.test(file.sha512))
      bad("sha512 must be 128 lower-case hex characters");
  } else if (typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256))
    bad("sha256 must be 64 lower-case hex characters");
  const path = file.path;
  if (
    typeof path !== "string" ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    bad("path must be a relative `/`-separated path without empty, . or .. parts");
}

type Algorithm = "sha256" | "sha512";

/** The pin's algorithm and expected digest; `validate` has made sure exactly one is given. */
function pinOf(file: PinnedDownload): { algorithm: Algorithm; want: string } {
  return file.sha512 !== undefined
    ? { algorithm: "sha512", want: file.sha512 }
    : { algorithm: "sha256", want: file.sha256 as string };
}

async function digestOf(path: string, algorithm: Algorithm): Promise<string | undefined> {
  try {
    return createHash(algorithm)
      .update(await readFile(path))
      .digest("hex");
  } catch {
    return undefined;
  }
}

/** Streams one URL to `partial` and returns its digest; a host silent for `stallMs` is given up. */
async function fetchTo(
  doFetch: typeof fetch,
  url: string,
  partial: string,
  stallMs: number,
  algorithm: Algorithm,
): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new Error(`no data from ${new URL(url).host} for ${stallMs} ms`)),
      stallMs,
    );
  };
  arm();
  try {
    const res = await doFetch(url, { redirect: "follow", signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
    if (!res.body) throw new Error(`no body from ${new URL(url).host}`);
    const hash = createHash(algorithm);
    const source = Readable.fromWeb(res.body as never);
    source.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      arm();
    });
    await pipeline(source, createWriteStream(partial), { signal: controller.signal });
    return hash.digest("hex");
  } catch (error) {
    throw controller.signal.aborted && controller.signal.reason instanceof Error
      ? controller.signal.reason
      : error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Downloads one pinned file to `dir`/`file.path` and returns its absolute path. The bytes are
 * streamed to a sibling partial file and hashed; only a match is renamed into place. A hash
 * mismatch fails at once, without trying another host. Partial files of `dest` left by a setup
 * that was killed mid-download are removed first.
 */
export async function pinnedDownload(
  dir: string,
  file: PinnedDownload,
  options: PinnedDownloadOptions = {},
): Promise<string> {
  validate(file);
  const dest = resolve(dir, ...file.path.split("/"));
  await mkdir(dirname(dest), { recursive: true });
  const prefix = `${basename(dest)}.partial-`;
  for (const name of await readdir(dirname(dest)))
    if (name.startsWith(prefix))
      await rm(join(dirname(dest), name), { force: true, recursive: true });
  const { algorithm, want } = pinOf(file);
  if ((await digestOf(dest, algorithm)) === want) return dest;
  const doFetch = options.fetch ?? fetch;
  const stallMs = options.stallMs ?? 60_000;
  const failures: string[] = [];
  for (const url of file.urls) {
    const partial = `${dest}.partial-${randomBytes(6).toString("hex")}`;
    options.log?.(`${file.path} ${file.version} from ${new URL(url).host}`);
    let got: string;
    try {
      got = await fetchTo(doFetch, url, partial, stallMs, algorithm);
    } catch (error) {
      await rm(partial, { force: true });
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (got !== want) {
      await rm(partial, { force: true });
      throw new ProviderError(
        `hash_mismatch: ${file.path} (version ${file.version}) from ${url} has ${algorithm} ${got}, expected ${want}`,
      );
    }
    try {
      await rename(partial, dest);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    return dest;
  }
  throw new ProviderError(
    `setup_failed: ${file.path} (version ${file.version}) could not be downloaded: ${failures.join("; ")}`,
  );
}

/** The context `assetgrove extensions setup <name>` hands a pack's `setup`. */
export function setupContext(input: {
  stateDir: string;
  search: SearchSettings;
  name: string;
  log?: (line: string) => void;
  fetch?: typeof fetch;
  stallMs?: number;
}): SetupContext {
  const dir = join(input.stateDir, "models");
  const write = input.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const log = (message: string) => write(`[${input.name}] ${message}`);
  return {
    stateDir: input.stateDir,
    dir,
    search: input.search,
    download: (file) =>
      pinnedDownload(dir, file, {
        ...(input.fetch && { fetch: input.fetch }),
        ...(input.stallMs !== undefined && { stallMs: input.stallMs }),
        log,
      }),
    log,
  };
}
