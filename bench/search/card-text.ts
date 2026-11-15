/** Writes the manifest's card texts from the images with a vision model. */
import { createHash } from "node:crypto";
import type { ImageSource } from "./fetch.ts";
import { containsStem, type Manifest } from "./manifest.ts";

export const CARD_PROMPT =
  "Describe this game asset image in one or two plain sentences for a searchable card: what it " +
  "shows, its subject, materials, colours and style. Do not mention a file name or an asset id.";

export interface VisionProvider {
  describe(image: Uint8Array, prompt: string): Promise<{ text: string; model: string }>;
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
export async function gatewayVision(model: string): Promise<VisionProvider> {
  const ai = (await import("ai")) as unknown as {
    generateText(o: unknown): Promise<{ text: string }>;
    createGateway(o: unknown): (id: string) => unknown;
  };
  const gateway = ai.createGateway({
    apiKey: process.env["AI_GATEWAY_API_KEY"],
    baseURL: `${process.env["FACTORY_GATEWAY_URL"]}/v4/ai`,
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
      return { text: r.text.trim(), model };
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
}

/** Fills `card` on every image that lacks one, recording model, prompt key and date. */
export async function writeCardTexts(o: WriteOptions): Promise<number> {
  const prompt = o.prompt ?? CARD_PROMPT;
  const key = createHash("sha256").update(prompt).digest("hex").slice(0, 12);
  const date = (o.now ?? (() => new Date()))().toISOString();
  let written = 0;
  for (const image of o.manifest.images) {
    if (image.card && !o.force) continue;
    let out = await o.provider.describe(await o.source.bytes(image), prompt);
    // A text that names its file would let search read the answer off the file name: ask once more.
    if (containsStem(out.text, image.file))
      out = await o.provider.describe(
        await o.source.bytes(image),
        `${prompt} Never write "${image.file}".`,
      );
    if (containsStem(out.text, image.file))
      throw new Error(`${image.id}: the vision model wrote the file stem into the card text`);
    o.manifest.prompts[key] = prompt;
    image.card = { text: out.text, model: out.model, prompt: key, date };
    written++;
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
