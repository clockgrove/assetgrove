/**
 * Region text (design section 3.4): `<box|mask=PATH> [frame N|view N] [ref PATH]... : <note>`, or
 * `t=<start>,<end> : <note>` for an audio asset. A box is `x,y,w,h` in pixels, or in percent when
 * every value ends in `%`; a time is `start,end` in seconds, the media-fragment temporal form, and
 * takes no frame, view or ref. `request_change` and `compare` take the same strings, though
 * `compare` refuses a time. Paths resolve inside the project root.
 */
import { resolve } from "node:path";
import { requireInsideProject } from "./bible.ts";
import { InputError } from "./errors.ts";
import type { Raster } from "./image/raster.ts";
import { parseTimeFragment } from "./library/review.ts";

/** A box in pixels or in percent of the image. */
export interface RegionBox {
  kind: "box";
  unit: "px" | "percent";
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A mask image: its opaque, light pixels are the region. */
export interface RegionMask {
  kind: "mask";
  /** Absolute path, inside the project root. */
  path: string;
}

/** A span of an audio asset in seconds, `t=<start>,<end>`. */
export interface RegionTime {
  kind: "time";
  start: number;
  end: number;
}

export interface Region {
  shape: RegionBox | RegionMask | RegionTime;
  frame?: number;
  view?: number;
  /** Absolute reference image paths, inside the project root. */
  refs: string[];
  note: string;
}

export interface ParseRegionOptions {
  /** Directory relative paths resolve against; the working directory by default. */
  base?: string;
  /** Whether the `: <note>` part is required; true by default. */
  requireNote?: boolean;
}

function malformed(text: string, why: string): InputError {
  return new InputError(
    `malformed region "${text}": ${why}; expected <x,y,w,h|mask=PATH> [frame N|view N] [ref PATH]... : <note>, or t=<start>,<end> : <note> for audio`,
  );
}

function positive(text: string, word: string, token: string | undefined): number {
  if (token === undefined || !/^[1-9]\d*$/.test(token))
    throw malformed(text, `${word} needs a whole number from 1`);
  return Number(token);
}

function parseBox(text: string, token: string): RegionBox {
  const parts = token.split(",");
  if (parts.length !== 4) throw malformed(text, `box "${token}" needs four values x,y,w,h`);
  const percent = parts.map((p) => p.endsWith("%"));
  if (percent.some((p) => p !== percent[0]))
    throw malformed(text, "a box is all pixels or all percent");
  const values = parts.map((p) => (percent[0] ? p.slice(0, -1) : p));
  if (!values.every((v) => /^\d+(\.\d+)?$/.test(v)))
    throw malformed(text, `box "${token}" holds a value that is not a non-negative number`);
  const [x, y, width, height] = values.map(Number) as [number, number, number, number];
  if (width <= 0 || height <= 0) throw malformed(text, "a box needs a width and height above 0");
  if (percent[0] && (x + width > 100 || y + height > 100))
    throw malformed(text, "a percent box must lie within 0 to 100");
  return { kind: "box", unit: percent[0] ? "percent" : "px", x, y, width, height };
}

function parseTime(text: string, token: string): RegionTime {
  const range = parseTimeFragment(token);
  if (range === undefined)
    throw malformed(text, `time "${token}" needs two non-negative seconds, t=[npt:]start,end`);
  if (range.end <= range.start) throw malformed(text, "a time region needs an end after its start");
  return { kind: "time", ...range };
}

/** Parses one region text; a malformed one or a path outside the project root is an InputError (exit 2). */
export function parseRegion(text: string, options: ParseRegionOptions = {}): Region {
  const base = resolve(options.base ?? process.cwd());
  const split = /:(?=\s|$)/.exec(text);
  const head = split ? text.slice(0, split.index) : text;
  const note = split ? text.slice(split.index + 1).trim() : "";
  if ((options.requireNote ?? true) && note === "") throw malformed(text, "it has no ': <note>'");
  const tokens = head.split(/\s+/).filter((t) => t !== "");
  const first = tokens.shift();
  if (first === undefined) throw malformed(text, "it names no box or mask");
  const region: Region = {
    shape: first.startsWith("t=")
      ? parseTime(text, first)
      : first.startsWith("mask=")
        ? { kind: "mask", path: resolve(base, first.slice(5)) }
        : parseBox(text, first),
    refs: [],
    note,
  };
  if (region.shape.kind === "time" && tokens.length > 0)
    throw malformed(text, "a time region takes no frame, view or ref");
  if (region.shape.kind === "mask" && first.length === 5)
    throw malformed(text, "mask= needs a path");
  while (tokens.length > 0) {
    const word = tokens.shift();
    if (word === "frame" || word === "view") {
      if (region.frame !== undefined || region.view !== undefined)
        throw malformed(text, "give one of frame N or view N, once");
      const n = positive(text, word, tokens.shift());
      if (word === "frame") region.frame = n;
      else region.view = n;
    } else if (word === "ref") {
      const path = tokens.shift();
      if (path === undefined) throw malformed(text, "ref needs a path");
      region.refs.push(resolve(base, path));
    } else throw malformed(text, `unexpected "${word}"`);
  }
  const paths = [...(region.shape.kind === "mask" ? [region.shape.path] : []), ...region.refs];
  requireInsideProject(paths, base, "a region");
  return region;
}

/** Parses each region text. */
export function parseRegions(texts: readonly string[], options: ParseRegionOptions = {}): Region[] {
  return texts.map((t) => parseRegion(t, options));
}

/** The pixel rectangle of a box on an image of the given size, clamped to the image. */
export function boxRect(
  box: RegionBox,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const sx = box.unit === "percent" ? width / 100 : 1;
  const sy = box.unit === "percent" ? height / 100 : 1;
  const x = Math.min(width, Math.max(0, Math.round(box.x * sx)));
  const y = Math.min(height, Math.max(0, Math.round(box.y * sy)));
  const right = Math.min(width, Math.round((box.x + box.width) * sx));
  const bottom = Math.min(height, Math.round((box.y + box.height) * sy));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** Whether a mask pixel is inside the region: opaque and light. */
export function maskInside(mask: Raster, x: number, y: number): boolean {
  const i = (y * mask.width + x) * 4;
  const d = mask.data;
  return (d[i + 3] ?? 0) > 127 && Math.max(d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0) > 127;
}
