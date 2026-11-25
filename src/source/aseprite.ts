/** Reads an Aseprite file into composited frames, with ase-parser doing the file decoding. */
import Aseprite from "ase-parser";
import { InputError } from "../errors.ts";
import { createRaster } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";

export interface AsepriteDocument {
  width: number;
  height: number;
  /** Each frame composited from its visible normal image layers, bottom to top. */
  frames: Raster[];
  durationsMs: number[];
  tags: Array<{ name: string; from: number; to: number }>;
}

const MAGIC = 0xa5e0;

export function readAseprite(bytes: Uint8Array, path: string): AsepriteDocument {
  const buffer = Buffer.from(bytes);
  const file = new Aseprite(buffer, path);
  try {
    if (buffer.length < 128 || buffer.readUInt16LE(4) !== MAGIC)
      throw new Error("not an Aseprite file");
    file.parse();
  } catch (error) {
    throw new InputError(`${path} is not a readable Aseprite file: ${(error as Error).message}`, {
      cause: error,
    });
  }

  // Header flag 1: layer opacity is valid; a file without it shows every layer opaque.
  const layerOpacity = (buffer.readUInt32LE(14) & 1) === 1;
  const shown = file.layers.map((layer, index) => effectivelyVisible(file.layers, index));
  file.layers.forEach((layer, index) => {
    if (!shown[index] || layer.flags.reference) return;
    if (layer.type === 2) {
      throw new InputError(`${path}: layer "${layer.name}" is a tilemap, which is not supported`);
    }
    if (layer.type === 0 && layer.blendMode !== 0) {
      throw new InputError(
        `${path}: layer "${layer.name}" uses blend mode ${layer.blendMode}; only normal is supported`,
      );
    }
    // A group's own blend mode and opacity apply to its children as one image, which is not drawn
    // here: refuse it rather than render the children as if it were normal and opaque.
    if (layer.type === 1 && (layer.blendMode !== 0 || (layerOpacity && layer.opacity < 255))) {
      throw new InputError(
        `${path}: group "${layer.name}" uses blend mode ${layer.blendMode} at opacity ${layer.opacity}; only a normal, opaque group is supported`,
      );
    }
  });

  const frames = file.frames.map((frame) => {
    const raster = createRaster(file.width, file.height);
    const cels = frame.cels
      .filter((cel) => cel !== undefined)
      .filter((cel) => {
        const layer = file.layers[cel.layerIndex];
        return layer?.type === 0 && shown[cel.layerIndex] === true && !layer.flags.reference;
      })
      .sort((a, b) => a.layerIndex + a.zIndex - (b.layerIndex + b.zIndex) || a.zIndex - b.zIndex);
    for (const cel of cels) paintCel(file, raster, cel, layerOpacity);
    return raster;
  });

  return {
    width: file.width,
    height: file.height,
    frames,
    durationsMs: file.frames.map((frame) => frame.frameDuration),
    tags: file.tags.map(({ name, from, to }) => ({ name, from, to })),
  };
}

/** A layer shows when it and every group above it is visible. */
function effectivelyVisible(layers: Aseprite.Layer[], index: number): boolean {
  let level = layers[index]?.layerChildLevel ?? 0;
  if (!layers[index]?.flags.visible) return false;
  for (let i = index - 1; i >= 0 && level > 0; i--) {
    const group = layers[i];
    if (group && group.layerChildLevel < level) {
      if (!group.flags.visible) return false;
      level = group.layerChildLevel;
    }
  }
  return true;
}

function paintCel(file: Aseprite, raster: Raster, cel: Aseprite.Cel, layerOpacity: boolean): void {
  const layer = file.layers[cel.layerIndex];
  if (!layer || !cel.rawCelData) return;
  const scale = (cel.opacity * (layerOpacity ? layer.opacity : 255)) / 65025;
  const data = cel.rawCelData;
  const depth = file.colorDepth;
  const bytesPerPixel = depth / 8;
  for (let y = 0; y < cel.h; y++) {
    for (let x = 0; x < cel.w; x++) {
      const cx = cel.xpos + x;
      const cy = cel.ypos + y;
      if (cx < 0 || cy < 0 || cx >= raster.width || cy >= raster.height) continue;
      const at = (y * cel.w + x) * bytesPerPixel;
      let r: number;
      let g: number;
      let b: number;
      let a: number;
      if (depth === 32) {
        [r, g, b, a] = [data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0, data[at + 3] ?? 0];
      } else if (depth === 16) {
        r = g = b = data[at] ?? 0;
        a = data[at + 1] ?? 0;
      } else {
        const index = data[at] ?? 0;
        const color = file.palette.colors[index];
        const transparent = index === file.paletteIndex && !layer.flags.background;
        [r, g, b, a] =
          color && !transparent ? [color.red, color.green, color.blue, color.alpha] : [0, 0, 0, 0];
      }
      over(raster, cx, cy, r, g, b, Math.round(a * scale));
    }
  }
}

/** Source-over of a non-premultiplied pixel, rounded to 8 bits. */
function over(
  raster: Raster,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  if (a === 0) return;
  const i = (y * raster.width + x) * 4;
  const d = raster.data;
  const backAlpha = (d[i + 3] ?? 0) / 255;
  const frontAlpha = a / 255;
  const outAlpha = frontAlpha + backAlpha * (1 - frontAlpha);
  const mix = (front: number, back: number) =>
    Math.round((front * frontAlpha + back * backAlpha * (1 - frontAlpha)) / outAlpha);
  d[i] = mix(r, d[i] ?? 0);
  d[i + 1] = mix(g, d[i + 1] ?? 0);
  d[i + 2] = mix(b, d[i + 2] ?? 0);
  d[i + 3] = Math.round(outAlpha * 255);
}
