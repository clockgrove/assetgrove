/**
 * A provider script module for `--provider-script` that answers `bible-staleness` decisions: an
 * asset is to be redone only when the call was shown its thumbnail, its subject is a lantern and
 * the bible's diff turns the lanterns' glow from amber to blue. It is paid, so its calls reach the
 * spend ledger. Every other call fails: library judge-stale makes none.
 */
import type { DecisionRequest } from "../../src/gateway/provider.ts";

export default {
  paid: true,
  image: () => {
    throw new Error("no image generation in staleness tests");
  },
  vision: () => {
    throw new Error("no vision calls in staleness tests");
  },
  decide: (request: DecisionRequest) => {
    if (request.operation !== "bible-staleness")
      throw new Error(`unexpected decision ${request.operation}`);
    const redo =
      request.images.length === 1 &&
      /subject lantern/.test(request.prompt) &&
      /^-Lanterns glow amber\.$/m.test(request.prompt) &&
      /^\+Lanterns glow blue\.$/m.test(request.prompt);
    return { answer: { type: "boolean", probability: redo ? 0.9 : 0.1 }, costUsd: 0.00003 };
  },
};
