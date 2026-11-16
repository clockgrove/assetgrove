/** Writes the manifest's card texts from the images with a vision model. */
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import type { ImageSource } from "./fetch.ts";
import type { Manifest } from "./manifest.ts";

export const CARD_PROMPT =
  "Describe this game asset image in one or two plain sentences for a searchable card: what it " +
  "shows, its subject, materials, colours and style. Do not mention a file name or an asset id.";

/**
 * Added to the prompt of a real run. A sprite's transparent background reaches the model as a plain
 * colour, and a spot-check found texts describing "a white background" the asset does not have.
 */
export const BACKGROUND_NOTE =
  "A plain white or transparent background is not part of the asset: do not describe the background. " +
  "The image may be a small sprite scaled up.";

/** The long side, in pixels, a smaller PNG is scaled up to before the vision call. */
export const MIN_VISION_SIDE = 256;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The bytes the vision model is shown. A PNG whose long side is under MIN_VISION_SIDE is scaled up by
 * a whole factor with nearest neighbour, so a 16-pixel sprite keeps its hard pixels and the model can
 * read it: a spot-check found wrong texts only on images that small. Other bytes pass unchanged.
 */
export function forVision(bytes: Uint8Array): Uint8Array {
  if (!PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) return bytes;
  const small = PNG.sync.read(Buffer.from(bytes));
  const factor = Math.ceil(MIN_VISION_SIDE / Math.max(small.width, small.height));
  if (factor <= 1) return bytes;
  const large = new PNG({ width: small.width * factor, height: small.height * factor });
  for (let y = 0; y < large.height; y++) {
    for (let x = 0; x < large.width; x++) {
      const from = (Math.floor(y / factor) * small.width + Math.floor(x / factor)) * 4;
      small.data.copy(large.data, (y * large.width + x) * 4, from, from + 4);
    }
  }
  return new Uint8Array(PNG.sync.write(large));
}

export interface VisionProvider {
  describe(
    image: Uint8Array,
    prompt: string,
  ): Promise<{ text: string; model: string; route?: string; requestId?: string }>;
}

/** Offline provider: describes an image from its bytes read as UTF-8 text (tests pass captions). */
export class ScriptedVision implements VisionProvider {
  async describe(image: Uint8Array): Promise<{ text: string; model: string }> {
    return {
      text: `A picture showing ${Buffer.from(image).toString("utf8")}.`,
      model: "scripted-vision",
    };
  }
}

/** The AI Gateway through the AI SDK (resolved at run time from core's install). */
export async function gatewayVision(
  model: string,
  options: { baseURL?: string; apiKey?: string } = {},
): Promise<VisionProvider> {
  const ai = (await import("ai")) as unknown as {
    generateText(o: unknown): Promise<{ text: string; response?: { id?: string } }>;
    createGateway(o: unknown): (id: string) => unknown;
  };
  const gateway = ai.createGateway({
    apiKey: options.apiKey ?? process.env["AI_GATEWAY_API_KEY"],
    baseURL: options.baseURL ?? "https://ai-gateway.vercel.sh/v4/ai",
  });
  return {
    async describe(image, prompt) {
      const r = await ai.generateText({
        model: gateway(model),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image", image },
            ],
          },
        ],
      });
      return { text: r.text.trim(), model, route: "ai-gateway", requestId: r.response?.id };
    },
  };
}

export interface WriteOptions {
  manifest: Manifest;
  source: ImageSource;
  provider: VisionProvider;
  prompt?: string;
  now?: () => Date;
  /** Rewrite texts that exist already (a spot-checked text is kept unless this is set). */
  force?: boolean;
  /** Called after each text is written, so a caller can save progress. */
  onWritten?: (image: Manifest["images"][number]) => Promise<void> | void;
  /** Refuse to make more vision calls than this: a spend cap for the run. */
  maxCalls?: number;
}

/** Fills `card` on every image that lacks one, recording model, prompt key and date. */
export async function writeCardTexts(o: WriteOptions): Promise<number> {
  const prompt = o.prompt ?? CARD_PROMPT;
  const keyOf = (p: string) => createHash("sha256").update(p).digest("hex").slice(0, 12);
  const date = (o.now ?? (() => new Date()))().toISOString();
  const maxCalls = o.maxCalls ?? Number.POSITIVE_INFINITY;
  let calls = 0;
  const call = async (image: Manifest["images"][number], p: string) => {
    if (++calls > maxCalls)
      throw new Error(`stopped after ${maxCalls} vision calls (the run's cap)`);
    return o.provider.describe(forVision(await o.source.bytes(image)), p);
  };
  let written = 0;
  for (const image of o.manifest.images) {
    if (image.card && !o.force) continue;
    const out = await call(image, prompt);
    const key = keyOf(prompt);
    o.manifest.prompts[key] = prompt;
    image.card = {
      text: out.text,
      model: out.model,
      prompt: key,
      date,
      ...(out.route ? { route: out.route } : {}),
      ...(out.requestId ? { requestId: out.requestId } : {}),
    };
    written++;
    await o.onWritten?.(image);
  }
  return written;
}

/** A seeded sample of image ids for a person to spot-check. */
export function spotCheckSample(manifest: Manifest, count: number, seed: string): string[] {
  const rank = (id: string) => createHash("sha256").update(`${seed}\0${id}`).digest("hex");
  return manifest.images
    .map((i) => i.id)
    .sort((a, b) => (rank(a) < rank(b) ? -1 : 1))
    .slice(0, count);
}

export function markSpotChecked(manifest: Manifest, ids: string[], by: string, date: string): void {
  for (const id of ids) {
    const card = manifest.images.find((i) => i.id === id)?.card;
    if (!card) throw new Error(`${id} has no card text to mark`);
    card.spotCheck = { by, date };
  }
}
