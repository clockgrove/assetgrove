import { createHash } from "node:crypto";
import { normalize, type Embedder } from "./embedder.ts";

function hashedVector(seed: string, dimension: number, weight: number, into: Float32Array): void {
  const h = createHash("sha256").update(seed).digest();
  const i = h.readUInt32BE(0) % dimension;
  const j = h.readUInt32BE(4) % dimension;
  into[i] = (into[i] as number) + weight;
  into[j] = (into[j] as number) - weight / 2;
}

/**
 * A deterministic embedder for offline tests. Text becomes a bag of hashed words, so texts that
 * share words are close. An image is embedded through its caption: the UTF-8 text of its bytes
 * (tests pass the caption as the "image"), so an image and a text can be made to match.
 */
export class ScriptedEmbedder implements Embedder {
  readonly id = "scripted";
  readonly revision = "1";
  readonly dimension: number;
  constructor(dimension = 768) {
    this.dimension = dimension;
  }

  private embedText(text: string): Float32Array {
    const v = new Float32Array(this.dimension);
    for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      hashedVector(w, this.dimension, 1, v);
    }
    return normalize(v);
  }

  async embedTexts(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.embedText(t));
  }

  async embedImages(images: Uint8Array[]): Promise<Float32Array[]> {
    return images.map((b) => this.embedText(Buffer.from(b).toString("utf8")));
  }
}
