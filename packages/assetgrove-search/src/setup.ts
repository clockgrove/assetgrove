import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SetupContext } from "@clockgrove/assetgrove/extension";
import { SearchError } from "./errors.ts";
import {
  MODEL_MANIFEST,
  isPinned,
  mirrorUrl,
  primaryUrl,
  type ModelManifest,
} from "./model-manifest.ts";

export interface SetupOptions {
  /** `<stateDir>/models`. */
  modelsDir: string;
  /** Tests point these at loopback servers; the defaults are the manifest's fixed hosts. */
  manifest?: ModelManifest;
  onProgress?: (message: string) => void;
  /**
   * Core's pinned download (`SetupContext.download`, `pinnedDownload`): the only way the package
   * fetches a file. It hashes the bytes before the file is used, deletes it on a mismatch and fails.
   */
  download: SetupContext["download"];
}

export function modelFolder(modelsDir: string, manifest: ModelManifest = MODEL_MANIFEST): string {
  return join(modelsDir, manifest.id);
}

async function sha256File(path: string): Promise<string | undefined> {
  try {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch {
    return undefined;
  }
}

/** True when every manifest file is present with its pinned hash. */
export async function modelIsInstalled(
  modelsDir: string,
  manifest: ModelManifest = MODEL_MANIFEST,
): Promise<boolean> {
  const dir = modelFolder(modelsDir, manifest);
  for (const f of manifest.files) {
    if ((await sha256File(join(dir, f.path))) !== f.sha256) return false;
  }
  return true;
}

/**
 * Every model file in `<modelsDir>/<id>`, each missing one fetched through core's pinned download
 * (`options.download`), pinned to the manifest's revision and sha256: the Hugging Face host first,
 * then the fixed mirror.
 */
export async function setupModel(options: SetupOptions): Promise<{ dir: string }> {
  const manifest = options.manifest ?? MODEL_MANIFEST;
  const say = options.onProgress ?? (() => {});
  if (!isPinned(manifest)) {
    throw new SearchError(
      "model_unpinned",
      "The model manifest has no pinned commit or sha256 values; refusing to download unverified weights.",
      {
        hint: "Run `pnpm pin-model` in packages/assetgrove-search where Hugging Face is reachable.",
      },
    );
  }
  const final = modelFolder(options.modelsDir, manifest);
  for (const file of manifest.files) {
    if ((await sha256File(join(final, file.path))) === file.sha256) continue;
    say(file.path);
    await options.download({
      urls: [
        primaryUrl(manifest, manifest.primaryBase, file),
        mirrorUrl(manifest.mirrorBase, file),
      ],
      version: manifest.revision,
      sha256: file.sha256,
      path: `${manifest.id}/${file.path}`,
    });
  }
  return { dir: final };
}

export async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
