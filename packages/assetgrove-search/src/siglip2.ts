import { join } from "node:path";
import type { Embedder } from "./embedder.ts";
import { normalize } from "./embedder.ts";
import { SearchError } from "./errors.ts";
import { flattenRgba, type RgbImage } from "./flatten.ts";
import { MODEL_MANIFEST, type ModelManifest } from "./model-manifest.ts";
import { exists, modelFolder } from "./setup.ts";
import { fitTokens } from "./tokens.ts";

const MAX_TEXT_TOKENS = 64;
const NEEDS_SETUP = "Run `assetgrove search setup` to download the model.";

/** Throws a structured error naming search setup when any model file is missing. No network call. */
export async function assertModelFiles(
  modelsDir: string,
  manifest: ModelManifest = MODEL_MANIFEST,
): Promise<string> {
  const dir = modelFolder(modelsDir, manifest);
  const missing: string[] = [];
  for (const f of manifest.files) if (!(await exists(join(dir, f.path)))) missing.push(f.path);
  if (missing.length > 0) {
    throw new SearchError(
      "model_missing",
      `The ${manifest.id} model is not installed (missing ${missing.join(", ")}). ${NEEDS_SETUP}`,
      { hint: NEEDS_SETUP, details: { missing, dir } },
    );
  }
  return dir;
}

// Transformers.js is loaded on demand: it is large, and its types are loose across modules.
type Tjs = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function toTensorImage(img: RgbImage, tjs: Tjs) {
  return new tjs.RawImage(new Uint8ClampedArray(img.data), img.width, img.height, 3);
}

/** SigLIP2 base patch16-224: image part fp32, text part int8, remote models off. */
export async function loadSiglip2(
  modelsDir: string,
  manifest: ModelManifest = MODEL_MANIFEST,
): Promise<Embedder> {
  await assertModelFiles(modelsDir, manifest);
  const tjs: Tjs = await import("@huggingface/transformers");
  tjs.env.allowRemoteModels = false;
  tjs.env.allowLocalModels = true;
  tjs.env.localModelPath = modelsDir;
  tjs.env.useBrowserCache = false;
  const name = manifest.id;
  const opts = { local_files_only: true };
  const tokenizer = await tjs.AutoTokenizer.from_pretrained(name, opts);
  const processor = await tjs.AutoProcessor.from_pretrained(name, opts);
  const textModel = await tjs.SiglipTextModel.from_pretrained(name, { ...opts, dtype: "int8" });
  const visionModel = await tjs.SiglipVisionModel.from_pretrained(name, { ...opts, dtype: "fp32" });

  const rows = (t: { data: Float32Array; dims: number[] }): Float32Array[] => {
    const dim = t.dims[t.dims.length - 1] as number;
    const n = t.dims[0] as number;
    return Array.from({ length: n }, (_, i) => normalize(t.data.slice(i * dim, (i + 1) * dim)));
  };

  return {
    id: manifest.id,
    revision: manifest.revision,
    dimension: manifest.dimension,
    async embedTexts(texts) {
      const inputs = tokenizer(texts, {
        padding: "max_length",
        truncation: true,
        max_length: MAX_TEXT_TOKENS,
      });
      // Truncation drops the end token; restore it on the rows that were cut.
      const ids: BigInt64Array = inputs.input_ids.data;
      texts.forEach((text, i) => {
        const full: number[] = tokenizer.encode(text);
        if (full.length <= MAX_TEXT_TOKENS) return;
        const plain: number[] = tokenizer.encode(text, { add_special_tokens: false });
        const fitted = fitTokens(full, plain, MAX_TEXT_TOKENS);
        fitted.forEach((id, j) => {
          ids[i * MAX_TEXT_TOKENS + j] = BigInt(id);
        });
      });
      const out = await textModel(inputs);
      return rows(out.pooler_output ?? out.text_embeds);
    },
    async embedImages(images) {
      const prepared = [];
      for (const bytes of images) {
        // Every format decodes the same way; anything with an alpha channel is flattened onto the
        // fixed background (Transformers.js's own rgb() would drop alpha without compositing).
        const raw = await tjs.RawImage.fromBlob(new Blob([bytes]));
        prepared.push(
          raw.channels === 4
            ? toTensorImage(flattenRgba(raw.width, raw.height, raw.data), tjs)
            : raw.rgb(),
        );
      }
      const inputs = await processor(prepared);
      const out = await visionModel(inputs);
      return rows(out.pooler_output ?? out.image_embeds);
    },
  };
}
