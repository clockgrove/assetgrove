/**
 * The boundary contrast measure of an icon: WCAG 2.2's contrast ratio between each boundary pixel
 * and the background pixel beside it, both composited over a flat background. Pure arithmetic over
 * RGBA bytes, so it needs nothing from core.
 */

/** Red, green and blue, each 0..255. */
export type Rgb = readonly [number, number, number];

/** An 8-bit RGBA image, row-major (core's `Raster`). */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}

/** The lowest contrast ratio an icon's boundary may have. */
export const MIN_CONTRAST = 3;

/** WCAG 2.2's relative luminance of an sRGB colour (channels may be fractional). */
export function relativeLuminance([r, g, b]: Rgb): number {
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2.2's contrast ratio of two colours, unrounded: 1 for the same colour, 21 for black on white. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** A straight-alpha colour over a background, unrounded. */
export function compositeOver(fg: Rgb, alpha: number, bg: Rgb): [number, number, number] {
  const a = alpha / 255;
  return [0, 1, 2].map((i) => a * (fg[i] as number) + (1 - a) * (bg[i] as number)) as [
    number,
    number,
    number,
  ];
}

/** A ratio cut (not rounded) to three decimals, so 2.9999 reads 2.999 and never 3.000. */
export function formatRatio(ratio: number): string {
  return (Math.floor(ratio * 1000) / 1000).toFixed(3);
}

export interface BoundaryContrast {
  /** The lowest ratio over every boundary pixel and neighbour; undefined when nothing is at the threshold. */
  minimum: number | undefined;
  /** How many (boundary pixel, outside neighbour) pairs were measured. */
  pairs: number;
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * The minimum contrast over the icon's boundary on `background`. A pixel is inside when its alpha
 * is at least `threshold`; a boundary pixel is an inside pixel with a 4-neighbour outside, and each
 * such pair is measured, both composited over the background. A neighbour beyond the image is the
 * bare background.
 */
export function boundaryContrast(
  image: Pixels,
  threshold: number,
  background: Rgb,
): BoundaryContrast {
  const { width, height, data } = image;
  const alphaAt = (x: number, y: number): number => data[(y * width + x) * 4 + 3] ?? 0;
  const over = (x: number, y: number): [number, number, number] => {
    const i = (y * width + x) * 4;
    return compositeOver(
      [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0],
      data[i + 3] ?? 0,
      background,
    );
  };
  let minimum: number | undefined;
  let pairs = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (alphaAt(x, y) < threshold) continue;
      const inside = over(x, y);
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx;
        const ny = y + dy;
        const beyond = nx < 0 || ny < 0 || nx >= width || ny >= height;
        if (!beyond && alphaAt(nx, ny) >= threshold) continue;
        const ratio = contrastRatio(inside, beyond ? background : over(nx, ny));
        pairs++;
        if (minimum === undefined || ratio < minimum) minimum = ratio;
      }
    }
  return { minimum, pairs };
}
