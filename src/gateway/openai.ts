/**
 * OpenAI's API, direct, through the AI SDK's own `@ai-sdk/openai` provider. OpenAI serves every 2D
 * role: images and edits through the images API, vision and planning through the Responses API,
 * decisions through structured output. Its endpoint is fixed and its key comes from
 * `OPENAI_API_KEY` (or the entry's `keyEnv`); both are passed to the SDK explicitly, so
 * `OPENAI_BASE_URL` never applies. OpenAI reports no cost to an ordinary key, so each call settles
 * at its route's estimate and spend is not reconciled. An `insufficient_quota` 429 is
 * `cap_refused` (src/gateway/failure.ts).
 */
import { createOpenAI } from "@ai-sdk/openai";
import { generateImage, generateText } from "ai";
import { ProviderError } from "../errors.ts";
import type { Route } from "../routes.ts";
import type { OutputGrant } from "../types.ts";
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

/** OpenAI's fixed endpoint, at the SDK's own path. */
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

type Client = ReturnType<typeof createOpenAI>;

const openaiGrant: OutputGrant = {
  license: "LicenseRef-openai-api",
  plan: "api",
  commercial: true,
  relabel: true,
};
const openaiTerms = "OpenAI Services Agreement and Usage Policies, direct API (as of 2026-11-14)";

function route(model: string, estimatedCostUsd: number, size?: string): Route {
  return {
    model,
    estimatedCostUsd,
    ...(size !== undefined && { size }),
    outputGrant: { ...openaiGrant },
    providerTerms: openaiTerms,
  };
}

/** The language model of OpenAI's vision, decisions and planning routes. */
const LANGUAGE_MODEL = "gpt-6.1-terra";
/** The image model of OpenAI's image and edit routes; it takes reference images. */
const IMAGE_MODEL = "gpt-image-2";

/**
 * The OpenAI adapter's default routes (design section 12): every 2D role. Image and edit on the
 * image model (estimates as the gateway's, the same model and price), the rest on the language
 * model.
 */
export const OPENAI_DEFAULT_ROUTES: Readonly<Record<string, Route>> = {
  still: route(IMAGE_MODEL, 0.25, "1024x1024"),
  sheet: route(IMAGE_MODEL, 0.3, "1536x1024"),
  edit: route(IMAGE_MODEL, 0.25, "1024x1024"),
  lookdev: route(IMAGE_MODEL, 0.25, "1024x1024"),
  ...Object.fromEntries(
    [
      "vision",
      "flicker",
      "holes",
      "lookdev-locate",
      "lookdev-groom",
      "lookdev-markings",
      "identity-cast",
      "identity-check",
      "material-qa",
      "identity",
      "compiler",
    ].map((operation) => [operation, route(LANGUAGE_MODEL, 0.02)]),
  ),
};

export class OpenAIProvider implements GenerationProvider {
  readonly billing: Billing;
  readonly #client: Client | undefined;
  readonly #keyEnv: string;

  /** Without a key every call fails with a provider error naming `keyEnv`. */
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

  #require(label: string): Client {
    if (this.#client === undefined)
      throw new ProviderError(
        `openai ${label}: ${this.#keyEnv} is not set; the OpenAI key must come from the environment`,
      );
    return this.#client;
  }

  readonly #guard = async <T>(label: string, call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      throw providerFailure("openai", label, error);
    }
  };

  async generateImage(req: ImageRequest): Promise<ImageResult> {
    const model = this.#require("image").image(req.model);
    const result = await this.#guard("image", () =>
      generateImage({
        model,
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
    const model = this.#require("vision").responses(req.model);
    const result = await this.#guard("vision", () =>
      generateText({
        model,
        messages: userMessage(req.prompt, req.images),
        ...(req.providerOptions !== undefined && {
          providerOptions: req.providerOptions as Record<string, never>,
        }),
      }),
    );
    return {
      text: result.text,
      ...requestId(result.response.headers?.["x-request-id"], result.response.id),
    };
  }

  /** A typed decision through structured output (`decisionSource: "structured-output"`). */
  async decide(req: DecisionRequest): Promise<DecisionResult> {
    return structuredDecision(
      "openai",
      this.#require("decide").responses(req.model),
      req,
      this.#guard,
    );
  }
}
