/**
 * `assetgrove extensions setup godot`: the Godot the pack runs. A binary at the path the pack's
 * settings give (`godot`) is used as it is. Otherwise setup downloads Godot 4.7.2 for this
 * platform through core's pinned download, checked against the SHA512 Godot publishes for it
 * (`src/godot-release.json`, from the release's `SHA512-SUMS.txt`), and unpacks it under the
 * state directory. Setup writes no settings: it returns the path to put in them.
 */
import { statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { SetupContext } from "@clockgrove/assetgrove/extension";
import { unzipSync } from "fflate";
import release from "./godot-release.json" with { type: "json" };

export const PACKAGE = "@clockgrove/assetgrove-godot";
/** Where the binary's path goes in the developer settings. */
export const SETTING = `extensionSettings["${PACKAGE}"].godot`;

export interface GodotArchive {
  archive: string;
  sha512: string;
  /** The executable's path inside the archive, `/`-separated. */
  binary: string;
}

export const GODOT_RELEASE: {
  version: string;
  release: string;
  sums: string;
  urls: string[];
  platforms: Record<string, GodotArchive>;
} = release;

/** A setup that cannot finish: exit 2 with the reason. */
export class GodotSetupError extends Error {
  readonly code = "invalid_input";
  constructor(message: string) {
    super(message);
    this.name = "GodotSetupError";
  }
}

/** The archive for a platform and architecture, or a refusal naming the ones there are. */
export function archiveFor(platform: string, arch: string): GodotArchive {
  const archive = GODOT_RELEASE.platforms[`${platform}-${arch}`];
  if (archive === undefined)
    throw new GodotSetupError(
      `Godot ${GODOT_RELEASE.version} has no pinned build for ${platform}-${arch} (pinned: ${Object.keys(GODOT_RELEASE.platforms).join(", ")}); put a Godot ${GODOT_RELEASE.version} binary's path in ${SETTING}`,
    );
  return archive;
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Unpacks a zip into `dir` (made fresh), refusing an entry that would land outside it. */
async function unpack(zip: Uint8Array, dir: string): Promise<void> {
  const entries = unzipSync(zip);
  const root = resolve(dir);
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    const path = resolve(root, ...name.split("/"));
    if (!path.startsWith(root + sep))
      throw new GodotSetupError(`the Godot archive holds ${name}, outside its folder`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
}

export interface GodotSetupResult {
  /** The executable's absolute path. */
  godot: string;
  version: string;
  /** `settings` when the developer settings named it, else `download`. */
  source: "settings" | "download";
  /** Where the path goes in the developer settings. */
  setting: string;
}

/**
 * Uses the binary the settings name, or downloads, checks and unpacks the pinned build for this
 * platform under `<dir>/godot/<release>/<platform>-<arch>/`.
 */
export async function setupGodot(
  ctx: SetupContext,
  settings: { godot?: string | undefined },
  platform: string = process.platform,
  arch: string = process.arch,
): Promise<GodotSetupResult> {
  if (settings.godot !== undefined && settings.godot !== "") {
    if (!isFile(settings.godot))
      throw new GodotSetupError(`${SETTING} names ${settings.godot}, which is not a file`);
    ctx.log(`using the Godot at ${settings.godot} (${SETTING})`);
    return {
      godot: settings.godot,
      version: GODOT_RELEASE.version,
      source: "settings",
      setting: SETTING,
    };
  }
  const pin = archiveFor(platform, arch);
  const base = `godot/${GODOT_RELEASE.release}`;
  const folder = join(ctx.dir, ...base.split("/"), `${platform}-${arch}`);
  const binary = join(folder, ...pin.binary.split("/"));
  const zip = await ctx.download({
    urls: GODOT_RELEASE.urls.map((url) => `${url}${pin.archive}`),
    version: GODOT_RELEASE.release,
    sha512: pin.sha512,
    path: `${base}/${pin.archive}`,
  });
  if (!isFile(binary)) {
    const partial = `${folder}.partial`;
    await rm(partial, { recursive: true, force: true });
    await unpack(new Uint8Array(await readFile(zip)), partial);
    if (!isFile(join(partial, ...pin.binary.split("/"))))
      throw new GodotSetupError(`the Godot archive ${pin.archive} holds no ${pin.binary}`);
    await rm(folder, { recursive: true, force: true });
    await rename(partial, folder);
  }
  if (platform !== "win32") await chmod(binary, 0o755);
  ctx.log(`Godot ${GODOT_RELEASE.version} is at ${binary}; put that path in ${SETTING}`);
  return { godot: binary, version: GODOT_RELEASE.version, source: "download", setting: SETTING };
}
