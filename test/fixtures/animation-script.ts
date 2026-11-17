/**
 * A provider script module for `--provider-script` on the animation commands: every flicker
 * decision answers that the identity holds (probability 0.03), unless the pair names frame 3 as its
 * second image, which is a flicker (0.91); every holes decision answers that nothing is missing
 * (0.1); every edit returns a synthetic figure with alpha; every motion-template decision answers
 * walk. Nothing here is real art.
 */
import { encodePng } from "../../src/image/raster.ts";
import { syntheticStrip } from "./strip.ts";

const figure = syntheticStrip({ count: 8, style: "painterly", motion: "walk" }).frames[2];

export default {
  image: () => ({
    images: [{ mediaType: "image/png", bytes: encodePng(figure as never) }],
    costUsd: 0.04,
  }),
  decide: (request: { prompt: string; operation?: string }) => {
    if (request.operation === "fix-scale") {
      return { answer: { type: "choice", choice: "area" }, costUsd: 0.001 };
    }
    if (request.operation === "holes") {
      return { answer: { type: "boolean", probability: 0.1 }, costUsd: 0.003 };
    }
    const flicker = /image 2 is frame 3\b/.test(request.prompt);
    return { answer: { type: "boolean", probability: flicker ? 0.91 : 0.03 }, costUsd: 0.01 };
  },
  vision: (request: { prompt: string }) => {
    if (/Magenta marks/.test(request.prompt)) {
      return {
        text: JSON.stringify({
          holes: false,
          areas: [{ where: "between the legs", kind: "opening" }],
          confidence: 0.9,
        }),
        costUsd: 0.003,
      };
    }
    const flicker = /image 2 is frame 3\b/.test(request.prompt);
    return {
      text: JSON.stringify(
        flicker
          ? { label: "flicker", confidence: 0.91, reason: "the tail rings change colour" }
          : { label: "same", confidence: 0.97, reason: "same fox" },
      ),
      costUsd: 0.01,
    };
  },
  // Every strip these tests draw is a walk cycle, so a family named otherwise is judged a walk.
  motionTemplate: () => ({ answer: { type: "choice", choice: "walk" }, costUsd: 0.001 }),
};
