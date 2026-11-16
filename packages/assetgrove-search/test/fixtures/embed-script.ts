/**
 * A `--provider-script` module whose scripted provider is paid and embeds (issue #242): a text is
 * a bag of hashed words and an image is embedded through its bytes' sha256, 768 wide. Every embed
 * call is counted on `globalThis.embedCalls`, by input kind, so a test sees what reached the
 * provider.
 */
import { createHash } from "node:crypto";

const DIMENSION = 768;

interface Calls {
  image: number;
  text: number;
}

const calls = ((globalThis as { embedCalls?: Calls }).embedCalls ??= { image: 0, text: 0 });

function vector(seeds: string[]): number[] {
  const v = new Array<number>(DIMENSION).fill(0);
  for (const seed of seeds) {
    const h = createHash("sha256").update(seed).digest();
    v[h.readUInt32BE(0) % DIMENSION]! += 1;
  }
  return v;
}

export default {
  paid: true,
  image: () => {
    throw new Error("this script only embeds");
  },
  vision: () => {
    throw new Error("this script only embeds");
  },
  embed: (request: {
    input: { image: { bytes: Uint8Array } } | { text: string };
    dimensions: number;
  }) => {
    if ("image" in request.input) {
      calls.image++;
      const sha = createHash("sha256").update(request.input.image.bytes).digest("hex");
      return { vector: vector([sha]), costUsd: 0.001 };
    }
    calls.text++;
    const words = request.input.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [""];
    return { vector: vector(words), costUsd: 0.001 };
  },
};
