import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  fetch?: typeof fetch;
  onProgress?: (message: string) => void;
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

async function download(doFetch: typeof fetch, url: string): Promise<Buffer> {
  const res = await doFetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Download every model file into `<modelsDir>/<id>`: the Hugging Face host first, then the fixed
 * mirror, per file. Each file's hash is checked before anything is moved; the files are staged in
 * a sibling folder and renamed into place at the end, so a failure leaves nothing half-written.
 */
export async function setupModel(options: SetupOptions): Promise<{ dir: string }> {
  const manifest = options.manifest ?? MODEL_MANIFEST;
  const doFetch = options.fetch ?? fetch;
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
  if (await modelIsInstalled(options.modelsDir, manifest)) return { dir: final };

  await mkdir(options.modelsDir, { recursive: true });
  // A killed or interrupted setup cannot run its `finally`: sweep what earlier runs left behind.
  for (const name of await readdir(options.modelsDir)) {
    if (name.startsWith(`.${manifest.id}.partial-`)) {
      await rm(join(options.modelsDir, name), { recursive: true, force: true });
    }
  }
  const stage = join(
    options.modelsDir,
    `.${manifest.id}.partial-${randomBytes(6).toString("hex")}`,
  );
  try {
    for (const file of manifest.files) {
      const attempts = [
        { host: "primary", url: primaryUrl(manifest, manifest.primaryBase, file) },
        { host: "mirror", url: mirrorUrl(manifest.mirrorBase, file) },
      ];
      const failures: string[] = [];
      let saved = false;
      for (const a of attempts) {
        say(`${file.path} from ${a.host}`);
        try {
          const bytes = await download(doFetch, a.url);
          const got = createHash("sha256").update(bytes).digest("hex");
          if (got !== file.sha256) {
            failures.push(`${a.host}: sha256 ${got} does not match ${file.sha256}`);
            continue;
          }
          const target = join(stage, file.path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, bytes);
          saved = true;
          break;
        } catch (error) {
          failures.push(`${a.host}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!saved) {
        const mismatch = failures.some((f) => f.includes("does not match"));
        throw new SearchError(
          mismatch ? "hash_mismatch" : "setup_failed",
          `Could not fetch ${file.path}: ${failures.join("; ")}`,
          { hint: "Run `assetgrove search setup` again.", details: { file: file.path, failures } },
        );
      }
    }
    await rm(final, { recursive: true, force: true });
    await rename(stage, final);
    return { dir: final };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
