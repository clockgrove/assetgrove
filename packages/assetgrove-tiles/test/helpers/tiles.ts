import type { KindCheck, MediaOutput, TargetProfile } from "@clockgrove/assetgrove/extension";
import { extensionContext, sampleBible, sampleProfile } from "@clockgrove/assetgrove/testing";
import { templateAtlas } from "../../src/corner16.ts";
import type { Pixels } from "../../src/corner16.ts";
import { flatTexture, tilesTerrainKind } from "../../src/kind.ts";

export const context = extensionContext("tiles");
export const kind = tilesTerrainKind(context);

export const spec = {
  kind: "tiles:terrain",
  assetId: "grass-dirt",
  fields: { terrains: { lower: "dirt", upper: "grass" } },
};

/** Two sample palette colours, the lower and the upper terrain. */
export const LOWER = [0x1d, 0x2b, 0x35, 255] as const;
export const UPPER = [0x5c, 0x8a, 0x4d, 255] as const;

/** A palette-rule style: edge strips are compared exactly. */
export const PALETTE_STYLE: TargetProfile["style"] = {
  color: { rule: "palette" },
  alpha: { mode: "binary" },
  edges: "crisp",
};

/** The target profile of the tiles kind at `tileSize`; no style is the painted default. */
export function profileOf(tileSize: number, style?: TargetProfile["style"]): TargetProfile {
  return sampleProfile({
    kinds: { "tiles:terrain": { tileSize } },
    ...(style !== undefined && { style }),
  });
}

/** The template-built set of two flat palette textures. */
export function templateSet(tileSize: number): Pixels {
  return templateAtlas(flatTexture(tileSize, LOWER), flatTexture(tileSize, UPPER));
}

/** Pixels as candidate media. */
export function atlasOutput(image: Pixels, tileSize: number): MediaOutput {
  return {
    mediaType: "image/png",
    extension: "png",
    bytes: context.raster.encodePng(image),
    fields: { layout: "corner-16", tileSize },
  };
}

/** A copy of `image` with one pixel set. */
export function withPixel(image: Pixels, x: number, y: number, rgba: readonly number[]): Pixels {
  const data = new Uint8Array(image.data);
  data.set(rgba, (y * image.width + x) * 4);
  return { ...image, data };
}

/** The reasons of one of the kind's exact checks on an atlas. */
export async function checkReasons(name: string, output: MediaOutput, profile: TargetProfile) {
  const check = kind.checks?.find((c) => c.name === name) as KindCheck;
  return check.run!({ spec, profile, bible: sampleBible(), output }, undefined as never);
}
