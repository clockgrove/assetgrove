import { PNG } from "pngjs";

/** The fixed background transparent pixels are flattened onto before embedding. */
export const FLATTEN_BACKGROUND = { r: 255, g: 255, b: 255 } as const;

export interface RgbImage {
  width: number;
  height: number;
  /** width × height × 3 bytes. */
  data: Uint8Array;
}

/** Composite straight-alpha RGBA onto the fixed background. */
export function flattenRgba(width: number, height: number, rgba: Uint8Array): RgbImage {
  const out = new Uint8Array(width * height * 3);
  const bg = [FLATTEN_BACKGROUND.r, FLATTEN_BACKGROUND.g, FLATTEN_BACKGROUND.b];
  for (let p = 0; p < width * height; p++) {
    const a = (rgba[p * 4 + 3] as number) / 255;
    for (let c = 0; c < 3; c++) {
      out[p * 3 + c] = Math.round((rgba[p * 4 + c] as number) * a + (bg[c] as number) * (1 - a));
    }
  }
  return { width, height, data: out };
}

export function flattenPng(bytes: Uint8Array): RgbImage {
  const png = PNG.sync.read(Buffer.from(bytes));
  return flattenRgba(png.width, png.height, png.data);
}
