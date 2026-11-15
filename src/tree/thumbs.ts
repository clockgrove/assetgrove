/**
 * Thumbnails for the asset tree (design section 2): at most 512 px on the long side, PNG, small
 * enough that their base64 fits what is left of a read's 64 KB, and cached in `<stateDir>/thumbs/`
 * by the source bytes' hash, the shape and the budget. A strip shows its key-frame row and a 3D
 * asset its turntable frames in one row. Uses the repository's raster, resample and PNG code.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { splitStrip } from "../animation/strip.ts";
import { keyIndexes } from "../contact.ts";
import { createRaster, decodeImage, encodePng } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { resampleTo } from "../image/resample.ts";
import { sha256Hex } from "../library/canonical.ts";

/** The longest side of a thumbnail. */
export const THUMB_PX = 512;
/** The most a read's encoded content may hold, in bytes (base64 counted for binary content). */
export const READ_LIMIT = 64 * 1024;

const GAP = 4;

/** The base64 length of `n` bytes. */
export function base64Length(n: number): number {
  return Math.ceil(n / 3) * 4;
}

function shrink(image: Raster, longest: number): Raster {
  const scale = Math.min(1, longest / Math.max(image.width, image.height));
  if (scale === 1) return image;
  const size = {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale)),
  };
  return resampleTo(image, scale, { x: 0, y: 0 }, size, "antialiased");
}

/** The images side by side on a transparent row, each scaled to the tallest one's height. */
function row(images: Raster[]): Raster {
  const height = Math.max(...images.map((i) => i.height));
  const scaled = images.map((i) =>
    i.height === height
      ? i
      : resampleTo(
          i,
          height / i.height,
          { x: 0, y: 0 },
          { width: Math.max(1, Math.round((i.width * height) / i.height)), height },
          "antialiased",
        ),
  );
  const width = scaled.reduce((sum, i) => sum + i.width, 0) + GAP * (scaled.length - 1);
  const out = createRaster(width, height);
  let x = 0;
  for (const image of scaled) {
    for (let y = 0; y < image.height; y++) {
      out.data.set(
        image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4),
        (y * width + x) * 4,
      );
    }
    x += image.width + GAP;
  }
  return out;
}

/** Whether an image is a strip: wider than tall by a whole number (two or more) of square frames. */
export function isStrip(image: Raster): boolean {
  return image.width > image.height && image.width % image.height === 0;
}

/** A strip's key frames (square frames), spread evenly, first and last included. */
export function keyFrames(strip: Raster): Raster[] {
  const frames = splitStrip(strip, { width: strip.height, height: strip.height });
  return keyIndexes(frames.length).map((i) => frames[i]!);
}

export type ThumbShape = "image" | "strip" | "row";

/**
 * A PNG thumbnail of `sources` (one image, a strip or a row of frames) whose base64 fits `budget`
 * bytes, or undefined when none fits or a source does not decode.
 */
export function thumbnail(
  sources: Uint8Array[],
  shape: ThumbShape,
  budget: number,
  cacheDir?: string,
): Uint8Array | undefined {
  if (sources.length === 0 || budget <= 0) return undefined;
  const key = sha256Hex(`${shape}:${budget}:${sources.map((s) => sha256Hex(s)).join(",")}`);
  const cached = cacheDir === undefined ? undefined : join(cacheDir, `${key}.png`);
  if (cached !== undefined) {
    try {
      return new Uint8Array(readFileSync(cached));
    } catch {
      // Not cached yet.
    }
  }
  let image: Raster;
  try {
    const decoded = sources.map((s) => decodeImage(s));
    image =
      shape === "row"
        ? row(decoded)
        : shape === "strip" && isStrip(decoded[0]!)
          ? row(keyFrames(decoded[0]!))
          : decoded[0]!;
  } catch {
    return undefined;
  }
  let longest = Math.min(THUMB_PX, Math.max(image.width, image.height));
  for (;;) {
    const png = encodePng(shrink(image, longest));
    if (base64Length(png.length) <= budget) {
      if (cached !== undefined) store(cacheDir!, cached, png);
      return png;
    }
    if (longest <= 8) return undefined;
    longest = Math.floor(longest * 0.75);
  }
}

function store(dir: string, path: string, png: Uint8Array): void {
  try {
    mkdirSync(dir, { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, png);
    renameSync(temporary, path);
  } catch {
    // A cache that cannot be written is only slower.
  }
}
