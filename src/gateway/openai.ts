import { createOpenAI } from "@ai-sdk/openai";
import { generateImage, generateText } from "ai";
import { ProviderError } from "../errors.ts";
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
import { decideStructured, requestIdOf, userMessage } from "./structured.ts";

/** OpenAI's API, at the SDK's own path; settings may not change it. */
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

type Client = ReturnType<typeof createOpenAI>;

/**
 * OpenAI's API through the AI SDK's `@ai-sdk/openai` provider: images (with references, an edit)
 * through the images API, vision and planning through the responses API, typed decisions through
 * structured output. The key is passed with the fixed endpoint, so `OPENAI_BASE_URL` and
 * `OPENAI_API_KEY` of the environment never apply on their own. An ordinary key reports no cost,
 * so each call settles at its route's estimate. A quota 429 is `cap_refused` (src/gateway/failure.ts).
 */
export class OpenAIProvider implements GenerationProvider {
  readonly billing: Billing;
  readonly #client: Client | undefined;
  readonly #keyEnv: string;

  constructor(options: {
    apiKey: string | undefined;
    keyEnv?: string;
    billing: Omit<Billing, "hosts" | "readLimit">;
  }) {
    this.#keyEnv = options.keyEnv ?? "OPENAI_API_KEY";
    this.#client =
      options.apiKey !== undefined && options.apiKey !== ""
        ? createOpenAI({ apiKey: options.apiKey, baseURL: OPENAI_BASE_URL })
        : undefined;
    this.billing = { ...options.billing, hosts: [new URL(OPENAI_BASE_URL).host] };
  }

  #clientFor(label: string): Client {
    if (this.#client === undefined)
      throw new ProviderError(
        `openai ${label}: ${this.#keyEnv} is not set; the OpenAI key must come from the environment`,
      );
    return this.#client;
  }

  async #guard<T>(label: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw providerFailure("openai", label, error);
    }
  }

  async generateImage(req: ImageRequest): Promise<ImageResult> {
    const model = this.#clientFor("image").image(req.model);
    const result = await this.#guard("image", () =>
      generateImage({
        model,
        // One request per reservation: an SDK retry would resend a paid call.
        maxRetries: 0,
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
      ...requestIdOf(result.responses[0]?.headers?.["x-request-id"]),
    };
  }

  async analyzeImages(req: VisionRequest): Promise<VisionResult> {
    const model = this.#clientFor("vision")(req.model);
    const result = await this.#guard("vision", () =>
      generateText({
        model,
        messages: userMessage(req.prompt, req.images),
        maxRetries: 0,
        ...(req.providerOptions !== undefined && {
          providerOptions: req.providerOptions as Record<string, never>,
        }),
      }),
    );
    return {
      text: result.text,
      ...requestIdOf(result.response.headers?.["x-request-id"], result.response.id),
    };
  }

  /** A typed decision through structured output (src/gateway/structured.ts). */
  async decide(req: DecisionRequest): Promise<DecisionResult> {
    const model = this.#clientFor("decide")(req.model);
    return decideStructured(
      "openai",
      model,
      req,
      (label, call) => this.#guard(label, call),
      "x-request-id",
    );
  }
}
