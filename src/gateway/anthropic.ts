/**
 * Anthropic's API, direct, through the AI SDK's own `@ai-sdk/anthropic` provider. Anthropic serves
 * vision, decisions (through structured output) and planning; it makes no images. Its endpoint is
 * fixed and its key comes from `ANTHROPIC_API_KEY` (or the entry's `keyEnv`); both are passed to
 * the SDK explicitly, so `ANTHROPIC_BASE_URL` never applies. Anthropic reports no cost to an
 * ordinary key, so each call settles at its route's estimate and spend is not reconciled.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
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

/** Anthropic's fixed endpoint, at the SDK's own path. */
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";

type Client = ReturnType<typeof createAnthropic>;

const anthropicGrant: OutputGrant = {
  license: "LicenseRef-anthropic-api",
  plan: "api",
  commercial: true,
  relabel: true,
};
const anthropicTerms = "Anthropic Commercial Terms of Service, direct API (as of 2026-11-14)";

/** One Anthropic route: the model, its upper per-call estimate, its grant and terms. */
function route(): Route {
  return {
    model: "claude-opus-5-5",
    // About 2,000 input tokens of images and prompt and up to 2,000 output tokens at $4/$20 per
    // million: $0.05; the estimate is a deliberate upper bound.
    estimatedCostUsd: 0.1,
    outputGrant: { ...anthropicGrant },
    providerTerms: anthropicTerms,
  };
}

/**
 * The Anthropic adapter's default routes (design section 12): every vision operation, the
 * decisions role (`identity`) and the planning role (`compiler`). No image or edit route.
 */
export const ANTHROPIC_DEFAULT_ROUTES: Readonly<Record<string, Route>> = Object.fromEntries(
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
  ].map((operation) => [operation, route()]),
);

export class AnthropicProvider implements GenerationProvider {
  readonly billing: Billing;
  readonly #client: Client | undefined;
  readonly #keyEnv: string;

  /** Without a key every call fails with a provider error naming `keyEnv`. */
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
    return this.#client.languageModel(model);
  }

  readonly #guard = async <T>(label: string, call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      throw providerFailure("anthropic", label, error);
    }
  };

  generateImage(_req: ImageRequest): Promise<ImageResult> {
    return Promise.reject(
      new ProviderError(
        "anthropic image: Anthropic makes no images; route image and edit elsewhere",
      ),
    );
  }

  async analyzeImages(req: VisionRequest): Promise<VisionResult> {
    const model = this.#model("vision", req.model);
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
      ...requestId(result.response.headers?.["request-id"], result.response.id),
    };
  }

  /** A typed decision through structured output (`decisionSource: "structured-output"`). */
  async decide(req: DecisionRequest): Promise<DecisionResult> {
    return structuredDecision("anthropic", this.#model("decide", req.model), req, this.#guard);
  }
}
