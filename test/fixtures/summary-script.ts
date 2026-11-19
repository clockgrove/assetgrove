/** A provider script like script.ts whose vision answer also carries a model-written summary. */
import base from "./script.ts";

const CHECKS = ["transparency", "frame-count", "identity", "perspective"];

export const SUMMARY = {
  description:
    "A brass porch lantern with amber glass, glowing warmly; a painterly prop for a cottage doorway.",
  tags: ["lantern", "brass", "light"],
};

export default {
  ...base,
  vision: () => ({
    text:
      "```json\n" +
      JSON.stringify({
        checks: CHECKS.map((check) => ({ check, passed: true, reason: "ok" })),
        summary: SUMMARY,
      }) +
      "\n```",
  }),
};
