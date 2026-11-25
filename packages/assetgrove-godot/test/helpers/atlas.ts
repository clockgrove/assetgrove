import { extensionContext } from "@clockgrove/assetgrove/testing";
import { CORNER_BITS } from "../../src/tile-set.ts";

const { raster } = extensionContext("t");

/**
 * A corner-16 atlas as the tiles pack's template draws one: 4 × 4 tiles of `tile` px, tile `i` at
 * column `i % 4`, row `floor(i / 4)`, each quadrant the upper colour where its corner's bit is set.
 */
export function cornerAtlas(
  tile: number,
  lower: readonly number[],
  upper: readonly number[],
): Uint8Array {
  const image = raster.create(4 * tile, 4 * tile);
  const half = Math.floor(tile / 2);
  for (let index = 0; index < 16; index++)
    for (let y = 0; y < tile; y++)
      for (let x = 0; x < tile; x++) {
        const corner = y < half ? (x < half ? "nw" : "ne") : x < half ? "sw" : "se";
        const colour = (index & CORNER_BITS[corner]) !== 0 ? upper : lower;
        raster.setPixel(image, (index % 4) * tile + x, Math.floor(index / 4) * tile + y, [
          ...colour,
        ] as [number, number, number, number]);
      }
  return raster.encodePng(image);
}

/** A `size` square PNG of one colour. */
export function flatPng(size: number, rgba: readonly number[]): Uint8Array {
  const image = raster.create(size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      raster.setPixel(image, x, y, [...rgba] as [number, number, number, number]);
  return raster.encodePng(image);
}
