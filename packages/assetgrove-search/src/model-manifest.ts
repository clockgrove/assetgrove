import manifestJson from "./model-manifest.json" with { type: "json" };

export interface ModelFile {
  path: string;
  /** Lower-case hex sha256; empty while the model is not pinned. */
  sha256: string;
}

export interface ModelManifest {
  id: string;
  repo: string;
  /** The Hugging Face commit the weights are pinned to; empty while not pinned. */
  revision: string;
  dimension: number;
  primaryBase: string;
  mirrorBase: string;
  files: ModelFile[];
}

export const MODEL_MANIFEST: ModelManifest = manifestJson;

export function isPinned(m: ModelManifest): boolean {
  return (
    /^[0-9a-f]{40}$/.test(m.revision) &&
    m.files.length > 0 &&
    m.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))
  );
}

/** Where a file lives on the Hugging Face host and on the mirror (a release's flat assets). */
export function primaryUrl(m: ModelManifest, base: string, file: ModelFile): string {
  return `${base}/${m.repo}/resolve/${m.revision}/${file.path}`;
}
export function mirrorUrl(base: string, file: ModelFile): string {
  return `${base}/${file.path.replaceAll("/", "__")}`;
}
