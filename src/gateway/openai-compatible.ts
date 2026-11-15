import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateImage, generateText, Output } from "ai";
import { z } from "zod";
import { ProviderError } from "../errors.ts";
import { providerFailure } from "./failure.ts";
import type {
  Billing,
  DecisionAnswer,
  DecisionRequest,
  DecisionResult,
  GenerationProvider,
  ImageRequest,
  ImageResult,
  VisionRequest,
  VisionResult,
} from "./provider.ts";

type Client = ReturnType<typeof createOpenAICompatible>;

function requestId(candidate: unknown): {
  requestId: string;
  requestIdSource: "provider" | "local";
} {
  if (typeof candidate === "string" && candidate !== "")
    return { requestId: candidate, requestIdSource: "provider" };
  return {
    requestId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    requestIdSource: "local",
  };
}

function userMessage(prompt: string, images: VisionRequest["images"]) {
  return [
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: prompt },
        ...images.map((i) => ({ type: "image" as const, image: i.bytes, mediaType: i.mediaType })),
      ],
    },
  ];
}

/**
 * Any OpenAI-compatible endpoint (a local image or chat server, or a hosted one), through the AI
 * SDK's own OpenAI-compatible provider. Images through the images API, vision through chat
 * completions, typed decisions through structured output. The endpoint reports no cost, so each
 * call settles at its route's estimate.
 */
export class OpenAICompatibleProvider implements GenerationProvider {
  readonly billing: Billing;
  readonly #client: Client;

  constructor(options: {
    baseURL: string;
    apiKey?: string;
    billing: Omit<Billing, "hosts" | "readLimit">;
  }) {
    this.#client = createOpenAICompatible({
      name: "openai-compatible",
      baseURL: options.baseURL,
      supportsStructuredOutputs: true,
      ...(options.apiKey !== undefined && { apiKey: options.apiKey }),
    });
    this.billing = { ...options.billing, hosts: [new URL(options.baseURL).host] };
  }

  async #guard<T>(label: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw providerFailure("openai-compatible", label, error);
    }
  }

  async generateImage(req: ImageRequest): Promise<ImageResult> {
    const result = await this.#guard("image", () =>
      generateImage({
        model: this.#client.imageModel(req.model),
        prompt:
          req.references.length === 0
            ? req.prompt
            : { text: req.prompt, images: req.references.map((r) => r.bytes) },
        ...(req.size !== undefined && { size: req.size as `${number}x${number}` }),
        ...(req.seed !== undefined && { seed: req.seed }),
        ...(req.providerOptions !== undefined && {
          providerOptions: req.providerOptions as Record<string, never>,
        }),
      }),
    );
    return {
      images: result.images.map((i) => ({ mediaType: i.mediaType, bytes: i.uint8Array })),
      ...requestId(result.responses[0]?.headers?.["x-request-id"]),
    };
  }

  async analyzeImages(req: VisionRequest): Promise<VisionResult> {
    const result = await this.#guard("vision", () =>
      generateText({
        model: this.#client.chatModel(req.model),
        messages: userMessage(req.prompt, req.images),
        ...(req.providerOptions !== undefined && {
          providerOptions: req.providerOptions as Record<string, never>,
        }),
      }),
    );
    return { text: result.text, ...requestId(result.response.id) };
  }

  /**
   * A typed decision through structured output: the model answers a score (one of the question's
   * levels, by index) or a probability that the statement holds.
   */
  async decide(req: DecisionRequest): Promise<DecisionResult> {
    const q = req.question;
    const top = q.type === "score" ? Math.max(1, q.levels.length - 1) : 1;
    const schema =
      q.type === "score"
        ? z.object({ score: z.number().min(0).max(top) })
        : z.object({ probability: z.number().min(0).max(1) });
    const instructions =
      q.type === "score"
        ? `${q.instructions}\nAnswer with score, the index (0 to ${top}) of the level that fits: ${q.levels.map((l, i) => `${i}: ${l}`).join("; ")}.`
        : `${q.instructions}\nAnswer with probability, from 0 to 1, that this holds.` +
          `${q.whenTrue !== undefined ? ` True means: ${q.whenTrue}.` : ""}` +
          `${q.whenFalse !== undefined ? ` False means: ${q.whenFalse}.` : ""}`;
    const result = await this.#guard("decide", () =>
      generateText({
        model: this.#client.chatModel(req.model),
        messages: userMessage(`${req.prompt}\n\n${instructions}`, req.images),
        output: Output.object({ schema }),
      }),
    );
    const raw = result.output as { score?: number; probability?: number } | undefined;
    let answer: DecisionAnswer;
    if (q.type === "score" && typeof raw?.score === "number")
      answer = { type: "score", score: raw.score };
    else if (q.type === "boolean" && typeof raw?.probability === "number")
      answer = { type: "boolean", probability: raw.probability };
    else throw new ProviderError("openai-compatible decide: the answer did not match the question");
    return { answer, ...requestId(result.response.id) };
  }
}
