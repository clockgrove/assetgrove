/**
 * Core's helpers a pack reaches through its `ExtensionContext` (design section 11), so it never
 * copies core's raster, QA or prompt code nor imports core by path. Each is core's own function.
 */
import { biblePalette } from "../bible.ts";
import { applyStyle } from "../image/apply-style.ts";
import {
  createRaster,
  decodeImage,
  decodePng,
  encodePng,
  getPixel,
  opaqueBox,
  parseHex,
  setPixel,
  toHex,
} from "../image/raster.ts";
import { flipHorizontal, resampleTo } from "../image/resample.ts";
import { isCutOut, sideBySide } from "../postprocess.ts";
import { combineQa, deterministicChecks } from "../qa.ts";
import {
  buildFramePrompt,
  buildStillPrompt,
  frameGrid,
  paletteSwatch,
  styleNotes,
  subjectOf,
  withNote,
} from "../request.ts";
import { resolveStyle } from "../style.ts";
import { boundsAt, cropRaster } from "../transform/raster-engine.ts";

/** Decode, encode, crop, scale, palette and grid functions over core's RGBA `Raster`. */
export const raster = Object.freeze({
  create: createRaster,
  getPixel,
  setPixel,
  /** Any image format core decodes, to RGBA. */
  decode: decodeImage,
  decodePng,
  encodePng,
  crop: cropRaster,
  /** The bounding box of pixels whose alpha is at least `threshold`. */
  bounds: boundsAt,
  opaqueBox,
  /** Resample by `scale` at `offset` into `size`, antialiased or crisp. */
  scale: resampleTo,
  flipHorizontal,
  parseHex,
  toHex,
  /** The style bible's palette, as `#rrggbb` strings. */
  palette: biblePalette,
  /** A PNG swatch of a palette, as a loaded reference image. */
  paletteSwatch,
  /** Re-applies a resolved style's alpha and colour rule (palette snap). */
  applyStyle,
  resolveStyle,
  /** Frames laid side by side in one strip. */
  grid: sideBySide,
  /** A spec's frame size and count, from the spec and the target profile. */
  frameGrid,
});

/** Core's deterministic QA checks: free, reproducible, no provider call. */
export const qa = Object.freeze({
  /** A strip's frame size, count, transparency and palette checks against a spec's expectation. */
  deterministicChecks,
  /** Whether an image has a transparent background (a cut-out). */
  isCutOut,
  /** The verdict of a candidate's reasons. */
  combine: combineQa,
});

/** The bible-to-prompt compiler: the prompts core's own kinds send. */
export const prompt = Object.freeze({
  still: buildStillPrompt,
  frame: buildFramePrompt,
  styleNotes,
  subjectOf,
  withNote,
});
