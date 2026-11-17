import type { Box, Point, Rgb, Size } from "./types.ts";
import { createRaster, getPixel, opaqueBox, parseHex, setPixel, toHex } from "./image/raster.ts";
import type { Raster } from "./image/raster.ts";
import { matteFigure } from "./sheet/matte.ts";
import { wholeImageFigure } from "./sheet/slice.ts";
import type { ResolvedStyle } from "./style.ts";

export interface PostprocessOptions {
  frame: Size;
  frameCount: number;
  anchor: Point;
  /** "#rrggbb" bible palette. */
  palette: string[];
  /**
   * RGB distance from the border's colour within which a pixel of an image that is not already cut
   * out can be background (the matte's slice tolerance). Default 48.
   */
  backgroundTolerance?: number;
  /** Pixels kept free around the subject inside the frame. Default 1. */
  margin?: number;
}

export interface Processed {
  strip: Raster;
  bounds: Box;
  /** Bible colours actually used, in bible order. */
  palette: string[];
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(
    (a[0] ?? 0) - (b[0] ?? 0),
    (a[1] ?? 0) - (b[1] ?? 0),
    (a[2] ?? 0) - (b[2] ?? 0),
  );
}

/** Share of a frame's border pixels that must be transparent for it to count as already cut out. */
const STRAY_BORDER = 0.02;

/** The style stage mattes at: binary alpha at 128, full colour (the palette is snapped after). */
const STAGE_MATTE_STYLE: ResolvedStyle = {
  alpha: { mode: "binary", threshold: 128 },
  color: { rule: "full", palette: [] },
  edges: "crisp",
};

/**
 * Whether an image is already cut out: its border holds real transparency, more than a stray
 * pixel's worth (over 2% of its border pixels, and at least two, below alpha 128). A subject that
 * covers part of the border, even most of it, still counts; a stray semi-transparent pixel in or on
 * the edge of an opaque image does not.
 */
export function isCutOut(src: Raster): boolean {
  const { width, height } = src;
  let border = 0;
  let clear = 0;
  const visit = (x: number, y: number) => {
    border++;
    if ((src.data[(y * width + x) * 4 + 3] ?? 255) < 128) clear++;
  };
  for (let x = 0; x < width; x++) {
    visit(x, 0);
    if (height > 1) visit(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    visit(0, y);
    if (width > 1) visit(width - 1, y);
  }
  return clear >= 2 && clear > STRAY_BORDER * border;
}

/**
 * A copy whose alpha is strictly 0 or 255. An image already cut out keeps its own alpha,
 * thresholded at 128, so its transparent pixels stay background whatever colour hides under them;
 * only an image whose border is opaque has its alpha ignored, and it is matted as opaque by the sheet path's matte
 * (`wholeImageFigure` then `matteFigure`): background is what is connected to the border and is the
 * border's colour, so a pale part of the subject next to a light background stays the subject's.
 */
function toTrueAlpha(src: Raster, tolerance: number): Raster {
  const out = createRaster(src.width, src.height);
  out.data.set(src.data);
  if (isCutOut(src)) {
    for (let i = 3; i < out.data.length; i += 4) out.data[i] = (out.data[i] ?? 0) < 128 ? 0 : 255;
    return out;
  }
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
  return matteFigure(wholeImageFigure(out, tolerance), STAGE_MATTE_STYLE).image;
}

/** Frames side by side on a transparent canvas, top-aligned: a strip's source as one image. */
export function sideBySide(frames: readonly Raster[]): Raster {
  const width = frames.reduce((w, f) => w + f.width, 0);
  const height = Math.max(1, ...frames.map((f) => f.height));
  const out = createRaster(Math.max(1, width), height);
  let ox = 0;
  for (const f of frames) {
    for (let y = 0; y < f.height; y++) {
      const row = f.data.subarray(y * f.width * 4, (y + 1) * f.width * 4);
      out.data.set(row, (y * out.width + ox) * 4);
    }
    ox += f.width;
  }
  return out;
}

/** Colours a cut-out is shown over: the one farthest from every colour it shows is used. */
const CONTRAST_COLOURS = ["#000000", "#ffffff", "#ff00ff", "#00ff00", "#00ffff", "#0000ff"];

/**
 * The cut-out composited over a contrasting colour (the one of CONTRAST_COLOURS farthest from every
 * colour it shows), so missing parts and attached background both show.
 */
export function overContrast(cutout: Raster): { image: Raster; colour: string } {
  const shown = new Set<number>();
  for (let i = 0; i < cutout.data.length; i += 4) {
    if ((cutout.data[i + 3] ?? 0) === 0) continue;
    shown.add(
      ((cutout.data[i] ?? 0) << 16) | ((cutout.data[i + 1] ?? 0) << 8) | (cutout.data[i + 2] ?? 0),
    );
  }
  const colours = [...shown].map((n): Rgb => [(n >> 16) & 255, (n >> 8) & 255, n & 255]);
  let colour = CONTRAST_COLOURS[0] as string;
  let best = -1;
  for (const hex of CONTRAST_COLOURS) {
    const c = parseHex(hex);
    const nearest = Math.min(Infinity, ...colours.map((o) => distance(o, c)));
    if (nearest > best) {
      best = nearest;
      colour = hex;
    }
  }
  const bg = parseHex(colour);
  const image = createRaster(cutout.width, cutout.height);
  for (let i = 0; i < cutout.data.length; i += 4) {
    const a = (cutout.data[i + 3] ?? 0) / 255;
    for (let k = 0; k < 3; k++) {
      image.data[i + k] = Math.round((cutout.data[i + k] ?? 0) * a + (bg[k] ?? 0) * (1 - a));
    }
    image.data[i + 3] = 255;
  }
  return { image, colour };
}

/** Resamples the box to dw x dh: area averaging when shrinking, nearest neighbour when growing. */
function resample(src: Raster, box: Box, dw: number, dh: number): Raster {
  const out = createRaster(dw, dh);
  const sx = box.width / dw;
  const sy = box.height / dh;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      if (sx <= 1 && sy <= 1) {
        const px = box.x + Math.min(box.width - 1, Math.floor((x + 0.5) * sx));
        const py = box.y + Math.min(box.height - 1, Math.floor((y + 0.5) * sy));
        setPixel(out, x, y, getPixel(src, px, py));
        continue;
      }
      const x0 = x * sx;
      const x1 = (x + 1) * sx;
      const y0 = y * sy;
      const y1 = (y + 1) * sy;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let area = 0;
      for (let py = Math.floor(y0); py < Math.ceil(y1); py++) {
        for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
          const w =
            (Math.min(px + 1, x1) - Math.max(px, x0)) * (Math.min(py + 1, y1) - Math.max(py, y0));
          const [pr, pg, pb, pa] = getPixel(src, box.x + px, box.y + py);
          area += w;
          const wa = w * (pa / 255);
          a += wa;
          r += pr * wa;
          g += pg * wa;
          b += pb * wa;
        }
      }
      if (area > 0 && a / area >= 0.5) {
        setPixel(out, x, y, [Math.round(r / a), Math.round(g / a), Math.round(b / a), 255]);
      }
    }
  }
  return out;
}

export function postprocessFrames(frames: Raster[], options: PostprocessOptions): Processed {
  const { frame, frameCount, anchor } = options;
  const tolerance = options.backgroundTolerance ?? 48;
  const margin = options.margin ?? 1;
  if (frames.length !== frameCount) {
    throw new Error(`expected ${frameCount} frames but got ${frames.length}`);
  }
  if (options.palette.length === 0) throw new Error("palette is empty");
  const palette = options.palette.map(parseHex);

  const keyed = frames.map((f) => toTrueAlpha(f, tolerance));
  const boxes = keyed.map((f, i) => {
    const box = opaqueBox(f);
    if (!box) throw new Error(`frame ${i} has no subject after background removal`);
    return box;
  });

  const availW = Math.max(1, frame.width - 2 * margin);
  const availH = Math.max(1, frame.height - 2 * margin);
  const maxW = Math.max(...boxes.map((b) => b.width));
  const maxH = Math.max(...boxes.map((b) => b.height));
  const scale = Math.min(availW / maxW, availH / maxH);

  const strip = createRaster(frame.width * frameCount, frame.height);
  const used = new Set<number>();
  let union: Box | undefined;

  keyed.forEach((src, i) => {
    const box = boxes[i] as Box;
    const dw = Math.min(frame.width, Math.max(1, Math.round(box.width * scale)));
    const dh = Math.min(frame.height, Math.max(1, Math.round(box.height * scale)));
    const scaled = resample(src, box, dw, dh);
    const ox = Math.min(frame.width - dw, Math.max(0, Math.round(anchor.x - dw / 2)));
    // The feet's row is the anchor's row, the ground line animation QA measures contact against.
    const oy = Math.min(frame.height - dh, Math.max(0, Math.round(anchor.y) + 1 - dh));
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const px = getPixel(scaled, x, y);
        if (px[3] === 0) continue;
        let bestIdx = 0;
        let bestDist = Infinity;
        palette.forEach((p: Rgb, idx) => {
          const dr = px[0] - p[0];
          const dg = px[1] - p[1];
          const db = px[2] - p[2];
          const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
          if (d < bestDist) {
            bestDist = d;
            bestIdx = idx;
          }
        });
        used.add(bestIdx);
        setPixel(strip, i * frame.width + ox + x, oy + y, [...(palette[bestIdx] as Rgb), 255]);
      }
    }
    const placed = opaqueBox(strip, { x: i * frame.width, y: 0, ...frame });
    if (!placed) throw new Error(`frame ${i} has no subject after scaling`);
    if (!union) union = placed;
    else {
      const x = Math.min(union.x, placed.x);
      const y = Math.min(union.y, placed.y);
      union = {
        x,
        y,
        width: Math.max(union.x + union.width, placed.x + placed.width) - x,
        height: Math.max(union.y + union.height, placed.y + placed.height) - y,
      };
    }
  });

  return {
    strip,
    bounds: union as Box,
    palette: options.palette
      .map((hex, idx) => ({ hex: toHex(palette[idx] as Rgb), idx }))
      .filter((p) => used.has(p.idx))
      .map((p) => p.hex),
  };
}
