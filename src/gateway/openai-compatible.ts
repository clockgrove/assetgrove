import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateImage, generateText } from "ai";
import { providerFailure } from "./failure.ts";
import type {
  Billing,
  DecisionRequest,
  DecisionResult,
  GenerationProvider,
  ImageRequest,
  ImageResult,
  VisionRequest,
  VisionResult,
} from "./provider.ts";
import { requestId, structuredDecision, userMessage } from "./structured.ts";

type Client = ReturnType<typeof createOpenAICompatible>;

/**
 * Any OpenAI-compatible endpoint (a local image or chat server, or a hosted one), through the AI
 * SDK's own OpenAI-compatible provider. Images through the images API, vision through chat
 * completions, typed decisions through structured output (`decisionSource:
 * "structured-output"`). The endpoint reports no cost, so each call settles at its route's
 * estimate.
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

  readonly #guard = async <T>(label: string, call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      throw providerFailure("openai-compatible", label, error);
    }
  };

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

  /** A typed decision through structured output on the chat model. */
  decide(req: DecisionRequest): Promise<DecisionResult> {
    return structuredDecision(
      "openai-compatible",
      this.#client.chatModel(req.model),
      req,
      this.#guard,
    );
  }
}
