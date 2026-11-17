/**
 * Synthetic inputs for pack tests (`@clockgrove/assetgrove/testing`): a style bible, a target
 * profile and a script for the scripted provider. Nothing here names a real game or its art.
 */
import type { Script } from "../gateway/scripted.ts";
import { createRaster, encodePng, setPixel } from "../image/raster.ts";
import type { StyleBible, TargetProfile } from "../types.ts";

/** The synthetic palette every sample uses. */
export const SAMPLE_PALETTE = ["#1d2b35", "#5c8a4d", "#d9c27a", "#f4efe1"];

/** An 8x8 PNG: a 4x4 square of the palette's second colour on transparency. */
export function samplePng(size = 8): Uint8Array {
  const r = createRaster(size, size);
  const q = Math.floor(size / 4);
  for (let y = q; y < size - q; y++)
    for (let x = q; x < size - q; x++) setPixel(r, x, y, [0x5c, 0x8a, 0x4d, 255]);
  return encodePng(r);
}

export function sampleBible(overrides: Partial<StyleBible> = {}): StyleBible {
  return {
    format: "assetgrove-style-bible/1",
    version: "sample-1",
    referenceLicense: "NOASSERTION",
    palette: [...SAMPLE_PALETTE],
    references: [],
    perspective: "refs/perspective.png",
    subjects: { sample: { description: "a synthetic sample subject" } },
    mood: ["calm"],
    ...overrides,
  };
}

export function sampleProfile(overrides: Partial<TargetProfile> = {}): TargetProfile {
  return {
    format: "assetgrove-target-profile/1",
    name: "sample-target",
    license: "MIT",
    frames: { width: 8, height: 8, maxEdge: 256, durationMs: 100 },
    layout: {
      media: "assets/{{spec.assetId}}.{{output.extension}}",
      manifest: "assets/manifests/{{spec.assetId}}.json",
    },
    manifest: { assetId: "{{spec.assetId}}", review: { status: "pending" } },
    review: { path: "review.status", pending: "pending" },
    ...overrides,
  };
}

/**
 * A script for the scripted provider: every image call answers `samplePng()` and every vision call
 * `{}`. Spread it into a script of your own to answer decisions or embeddings too.
 */
export function sampleScript(): Script {
  return {
    image: () => ({ images: [{ mediaType: "image/png", bytes: samplePng() }] }),
    vision: () => ({ text: "{}" }),
  };
}
