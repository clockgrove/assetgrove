/** A provider script module for `--provider-script`: every vision call answers one card summary. */
export const SUMMARY = {
  description: "A brass porch lantern with amber glass; a prop for a cottage doorway.",
  tags: ["lantern", "brass"],
};

export default {
  paid: true,
  image: () => {
    throw new Error("no image generation in card describe tests");
  },
  vision: () => ({ text: JSON.stringify(SUMMARY), costUsd: 0.001 }),
};
