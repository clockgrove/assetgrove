/** An embedder turns images and text into vectors of one space. */
export interface Embedder {
  /** Stable name, e.g. `siglip2-base`. */
  readonly id: string;
  /** The pinned revision of the weights (a commit), or a version for scripted embedders. */
  readonly revision: string;
  readonly dimension: number;
  /** Each image is encoded file bytes (any format the decoder reads). Returns unit vectors. */
  embedImages(images: Uint8Array[]): Promise<Float32Array[]>;
  /** Returns unit vectors. */
  embedTexts(texts: string[]): Promise<Float32Array[]>;
}

/** Normalise to unit length in place-safe fashion (zero vectors stay zero). */
export function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  return n === 0 ? v : v.map((x) => x / n);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    d += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : d / Math.sqrt(na * nb);
}
