/** A provider script module for `--provider-script`: passes QA, mirroring scriptedProvider. */
import { decodeImage, encodePng, getPixel, setPixel } from "../../src/image/raster.ts";
import { drawSubject } from "./synthetic.ts";

const CHECKS = ["transparency", "frame-count", "identity", "perspective"];

export default {
  image: (request: { prompt: string; references?: Array<{ bytes: Uint8Array }> }) => {
    // A request-change edit: the current version (reference 1) with its opaque pixels darkened,
    // so it keeps the version's size and transparency as a real edit does.
    const current = request.references?.[0];
    if (current && request.prompt.startsWith("Reference image 1 is the current version")) {
      const image = decodeImage(current.bytes);
      for (let y = 0; y < image.height; y++)
        for (let x = 0; x < image.width; x++) {
          const [r, g, b, a] = getPixel(image, x, y);
          if (a > 0) setPixel(image, x, y, [r >> 1, g >> 1, b >> 1, a]);
        }
      return { images: [{ mediaType: "image/png", bytes: encodePng(image) }] };
    }
    const m = /frame (\d+) of/.exec(request.prompt);
    return {
      images: [
        { mediaType: "image/png", bytes: encodePng(drawSubject(96, m?.[1] ? Number(m[1]) : 0)) },
      ],
    };
  },
  decide: (request: { operation?: string }) => {
    if (request.operation !== "fix-scale")
      throw new Error("the provider script has no decide answer");
    return { answer: { type: "choice", choice: "area" }, costUsd: 0.001 };
  },
  vision: () => ({
    text:
      "```json\n" +
      JSON.stringify({ checks: CHECKS.map((check) => ({ check, passed: true, reason: "ok" })) }) +
      "\n```",
  }),
};
