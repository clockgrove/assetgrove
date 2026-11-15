import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
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

/** Anthropic's API, at the SDK's own path; settings may not change it. */
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";

type Client = ReturnType<typeof createAnthropic>;

/**
 * Anthropic's API through the AI SDK's `@ai-sdk/anthropic` provider: vision through messages and
 * typed decisions through structured output. It has no image models. The key is passed with the
 * fixed endpoint, so `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` of the environment never apply
 * on their own. An ordinary key reports no cost, so each call settles at its route's estimate.
 */
export class AnthropicProvider implements GenerationProvider {
  readonly billing: Billing;
  readonly #client: Client | undefined;
  readonly #keyEnv: string;

  constructor(options: {
    apiKey: string | undefined;
    keyEnv?: string;
    billing: Omit<Billing, "hosts" | "readLimit">;
  }) {
    this.#keyEnv = options.keyEnv ?? "ANTHROPIC_API_KEY";
    this.#client =
      options.apiKey !== undefined && options.apiKey !== ""
        ? createAnthropic({ apiKey: options.apiKey, baseURL: ANTHROPIC_BASE_URL })
        : undefined;
    this.billing = { ...options.billing, hosts: [new URL(ANTHROPIC_BASE_URL).host] };
  }

  #model(label: string, model: string) {
    if (this.#client === undefined)
      throw new ProviderError(
        `anthropic ${label}: ${this.#keyEnv} is not set; the Anthropic key must come from the environment`,
      );
    return this.#client(model);
  }

  async #guard<T>(label: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw providerFailure("anthropic", label, error);
    }
  }

  generateImage(_req: ImageRequest): Promise<ImageResult> {
    return Promise.reject(new ProviderError("anthropic image: Anthropic has no image models"));
  }

  async analyzeImages(req: VisionRequest): Promise<VisionResult> {
    const model = this.#model("vision", req.model);
    const result = await this.#guard("vision", () =>
      generateText({
        model,
        messages: userMessage(req.prompt, req.images),
        // One request per reservation: an SDK retry would resend a paid call.
        maxRetries: 0,
        ...(req.providerOptions !== undefined && {
          providerOptions: req.providerOptions as Record<string, never>,
        }),
      }),
    );
    return {
      text: result.text,
      ...requestIdOf(result.response.headers?.["request-id"], result.response.id),
    };
  }

  /** A typed decision through structured output (src/gateway/structured.ts). */
  async decide(req: DecisionRequest): Promise<DecisionResult> {
    const model = this.#model("decide", req.model);
    return decideStructured(
      "anthropic",
      model,
      req,
      (label, call) => this.#guard(label, call),
      "request-id",
    );
  }
}
