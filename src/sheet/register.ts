/**
 * Registration: every figure gets the same scale (after per-family normalisation) and is placed so
 * its feet baseline sits on anchor.y and its pin point's x on anchor.x, in the target's frame size.
 * The pin is chosen per figure: `center` (the default), the alpha-weighted centre of mass, or
 * `footprint`, the centre x of the pixels at or above the measure threshold in the bottom 10% of the
 * figure's height. A planted family pins the footprint, because a pose whose head drops or tail
 * swings moves its centre of mass while its feet stay put; pinning the centre of mass would slide
 * the feet. A family whose contacts move (a walk) pins the centre of mass, because pinning the
 * swinging feet would slide the body.
 *
 * Coordinate convention: the centre of a pixel in column x is x + 0.5, so a figure whose pin point
 * is centred on the anchor column has x = anchor.x + 0.5; the baseline is a row index.
 */
import { InputError } from "../errors.ts";
import { flipHorizontal, resampleTo } from "../image/resample.ts";
import type { Raster } from "../image/raster.ts";
import { opaqueBox } from "../image/raster.ts";
import type { Point, Transform } from "../types.ts";
import type {
  FrameMeasure,
  RegisterOptions,
  RegisteredFrame,
  RegisterPin,
  Registration,
} from "./types.ts";

export { flipHorizontal };

export function measureFrame(image: Raster, threshold = 128): FrameMeasure | undefined {
  let baseline = -1;
  let top = -1;
  let sum = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const a = image.data[(y * image.width + x) * 4 + 3] as number;
      if (a === 0) continue;
      sum += a;
      sx += a * (x + 0.5);
      sy += a * (y + 0.5);
      if (a >= threshold) {
        baseline = y;
        if (top < 0) top = y;
      }
    }
  }
  if (baseline < 0) return undefined;
  const rows = Math.max(1, Math.round(0.1 * (baseline - top + 1)));
  let footSum = 0;
  let footN = 0;
  for (let y = baseline - rows + 1; y <= baseline; y++) {
    for (let x = 0; x < image.width; x++) {
      if ((image.data[(y * image.width + x) * 4 + 3] as number) < threshold) continue;
      footSum += x + 0.5;
      footN++;
    }
  }
  return {
    baseline,
    footX: footSum / footN,
    centerX: sx / sum,
    centerY: sy / sum,
    area: sum / 255,
  };
}

/** The x a figure is pinned by: its centre of mass, or its ground footprint's centre. */
export function pinX(m: FrameMeasure, pin: RegisterPin = "center"): number {
  return pin === "footprint" ? m.footX : m.centerX;
}

function deviation(m: FrameMeasure | undefined, anchor: Point, pin: RegisterPin): number {
  if (!m) return Number.POSITIVE_INFINITY;
  return Math.max(Math.abs(m.baseline - anchor.y), Math.abs(pinX(m, pin) - (anchor.x + 0.5)));
}

/**
 * Largest deviation of baseline and pin point from the anchor, per frame and overall, in px. `pins`
 * is one pin per frame (default: every frame's centre of mass).
 */
export function jitterOf(
  frames: Raster[],
  anchor: Point,
  threshold = 128,
  pins?: readonly RegisterPin[],
): { maxPx: number; perFrame: number[] } {
  const perFrame = frames.map((f, i) =>
    deviation(measureFrame(f, threshold), anchor, pins?.[i] ?? "center"),
  );
  return { maxPx: Math.max(0, ...perFrame), perFrame };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function registerFrames(figures: Raster[], options: RegisterOptions): Registration {
  const { frame, anchor, edges } = options;
  const threshold = options.measureThreshold ?? 128;
  const margin = options.margin ?? 1;
  const [lo, hi] = options.clamp ?? [0.8, 1.25];
  const measures = figures.map((f, i) => {
    const m = measureFrame(f, threshold);
    if (!m) throw new InputError(`figure ${i + 1} has no pixel at or above alpha ${threshold}`);
    return m;
  });

  const pins = options.pins ?? figures.map((): RegisterPin => "center");
  if (pins.length !== figures.length) throw new InputError("pins must name one pin per figure");
  const pinOf = (i: number) => pins[i] as RegisterPin;

  const norms = measures.map(() => 1);
  if (options.families) {
    const { families } = options;
    if (families.length !== figures.length)
      throw new InputError("families must name one family per figure");
    measures.forEach((m, i) => {
      const peers = measures.filter((_, j) => families[j] === families[i]);
      const target = median(peers.map((p) => Math.sqrt(p.area)));
      norms[i] = Math.min(hi, Math.max(lo, target / Math.sqrt(m.area)));
    });
  }

  let scale = options.scale;
  if (scale === undefined) {
    // Per unit scale, each figure's reach left, right and above its anchor point; rows below the
    // baseline are faint and may be clipped by the frame bottom.
    let best = Number.POSITIVE_INFINITY;
    figures.forEach((f, i) => {
      const box = opaqueBox(f);
      const m = measures[i] as FrameMeasure;
      const n = norms[i] as number;
      if (!box) return;
      const px = pinX(m, pinOf(i));
      const left = (px - box.x) * n;
      const right = (box.x + box.width - px) * n;
      const up = (m.baseline + 1 - box.y) * n;
      best = Math.min(
        best,
        (anchor.x + 0.5 - margin) / left,
        (frame.width - margin - anchor.x - 0.5) / right,
        (anchor.y + 1 - margin) / up,
      );
    });
    if (!Number.isFinite(best) || best <= 0)
      throw new InputError("the figures do not fit the frame");
    scale = best;
  }

  const frames: RegisteredFrame[] = figures.map((f, i) => {
    const m = measures[i] as FrameMeasure;
    const n = norms[i] as number;
    const t = scale * n;
    const pin = pinOf(i);
    let x = anchor.x + 0.5 - pinX(m, pin) * t;
    let y = anchor.y + 1 - (m.baseline + 1) * t;
    if (edges === "crisp") {
      x = Math.round(x);
      y = Math.round(y);
    }
    const place = (px: number) => {
      const img = resampleTo(f, t, { x: px, y }, frame, edges);
      return { img, m: measureFrame(img, threshold) };
    };
    let placed = place(x);
    let best = { x, placed };
    let cx = x;
    // A thin footprint resamples unevenly (whole pixels, or soft edges below the cut), so its centre
    // can land off the anchor: nudge the placement toward it and keep the closest.
    for (let pass = 0; pin === "footprint" && pass < 4 && placed.m; pass++) {
      const gap = anchor.x + 0.5 - placed.m.footX;
      const nx = edges === "crisp" ? cx + (Math.round(gap) || Math.sign(gap)) : cx + gap;
      if (nx === cx) break;
      cx = nx;
      placed = place(cx);
      if (
        placed.m &&
        (!best.placed.m || deviation(placed.m, anchor, pin) < deviation(best.placed.m, anchor, pin))
      )
        best = { x: cx, placed };
    }
    x = best.x;
    placed = best.placed;
    const image = placed.img;
    const measure = placed.m;
    if (!measure) throw new InputError(`figure ${i + 1} vanished when scaled into the frame`);
    const transforms: Transform[] = [];
    if (options.families) transforms.push({ op: "normalize-scale", factor: n });
    transforms.push({ op: "scale", factor: t, filter: edges });
    transforms.push({ op: "place", offset: { x, y }, frame: { ...frame }, anchor: { ...anchor } });
    return { image, measure, jitterPx: deviation(measure, anchor, pin), transforms };
  });

  return { frames, scale, jitterPx: Math.max(0, ...frames.map((f) => f.jitterPx)) };
}
