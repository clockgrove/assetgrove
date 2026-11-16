/**
 * A provider script module for `--provider-script` that answers `style-outlier` decisions by
 * looking: the first image (the member) is drawn in another style when its dominant hue (warm or
 * cool, the stand-in for a painterly or a pixel-art palette) differs from the contact sheet's.
 * Subject and pose (the shape drawn) never change the answer. It is paid, so its calls reach the
 * spend ledger. Every other call fails: find --outliers makes none.
 */
import type { DecisionRequest } from "../../src/gateway/provider.ts";
import { decodeImage } from "../../src/image/raster.ts";

/** "warm", "cool" or "none": which of red or blue dominates the image's coloured pixels. */
export function hueOf(bytes: Uint8Array): "warm" | "cool" | "none" {
  const image = decodeImage(bytes);
  let warm = 0;
  let cool = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const r = image.data[i] as number;
    const b = image.data[i + 2] as number;
    if (r > b + 60) warm++;
    else if (b > r + 60) cool++;
  }
  if (warm === 0 && cool === 0) return "none";
  return warm > cool ? "warm" : "cool";
}

export function styleOutlier(request: DecisionRequest) {
  if (request.operation !== "style-outlier")
    throw new Error(`unexpected decision ${request.operation}`);
  const [member, sheet] = request.images;
  const differs =
    request.images.length === 2 &&
    /drawn in a different art style/.test(request.question.instructions ?? "") &&
    hueOf(member!.bytes) !== hueOf(sheet!.bytes);
  return {
    answer: { type: "boolean" as const, probability: differs ? 0.9 : 0.1 },
    costUsd: 0.00003,
  };
}

export default {
  paid: true,
  image: () => {
    throw new Error("no image generation in style-outlier tests");
  },
  vision: () => {
    throw new Error("no vision calls in style-outlier tests");
  },
  styleOutlier,
};
