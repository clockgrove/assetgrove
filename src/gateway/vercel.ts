import { createGateway, experimental_decide, generateImage, generateText } from "ai";
import { ProviderError } from "../errors.ts";
import { providerFailure } from "./failure.ts";
import type {
  Billing,
  LimitReading,
  DecisionAnswer,
  DecisionRequest,
  DecisionResult,
  GenerationProvider,
  ImageRequest,
  ImageResult,
  VisionRequest,
  VisionResult,
} from "./provider.ts";

/** The gateway's fixed endpoint, at the gateway SDK's own path. */
const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v4/ai";

type Gateway = ReturnType<typeof createGateway>;
type Metadata = Record<string, Record<string, unknown> | undefined> | undefined;

function toNumber(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function gatewayMeta(metadata: Metadata): Record<string, unknown> {
  return metadata?.["gateway"] ?? {};
}

function requestId(...candidates: unknown[]): {
  requestId: string;
  requestIdSource: "provider" | "local";
} {
  for (const c of candidates) {
    if (typeof c === "string" && c !== "") return { requestId: c, requestIdSource: "provider" };
  }
  return {
    requestId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    requestIdSource: "local",
  };
}

/**
 * The Vercel AI Gateway adapter, the only place that touches the `ai` SDK.
 *
 * Request ID, in order of preference: the gateway generation ID from provider metadata, the
 * `x-vercel-id` response header (images) or the response ID (vision), else a generated
 * `local-<timestamp>-<random>` with `requestIdSource: "local"`, so provenance always has one and
 * never passes it off as the provider's. Cost is the gateway's reported
 * `cost` (USD) from provider metadata, left unset when the gateway does not report one.
 */
export class VercelGateway implements GenerationProvider {
  readonly billing: Billing;
  readonly #gateway: Gateway | undefined;
  readonly #keyEnv: string;

  /**
   * `apiKey` and `baseURL` are always passed to the SDK, so no `*_BASE_URL` or key variable of the
   * environment ever applies. Without a key every call fails with a provider error naming
   * `keyEnv`.
   */
  constructor(options: {
    apiKey: string | undefined;
    keyEnv?: string;
    baseURL?: string;
    billing?: Omit<Billing, "hosts" | "readLimit" | "callCost">;
  }) {
    const baseURL = options.baseURL ?? GATEWAY_BASE_URL;
    this.#keyEnv = options.keyEnv ?? "AI_GATEWAY_API_KEY";
    this.#gateway =
      options.apiKey !== undefined && options.apiKey !== ""
        ? createGateway({ apiKey: options.apiKey, baseURL })
        : undefined;
    this.billing = {
      adapter: "vercel-ai-gateway",
      providerId: "vercel-ai-gateway",
      paid: true,
      reconcile: "per-call-cost",
      ...options.billing,
      hosts: [new URL(baseURL).host],
      readLimit: () => this.credits(),
      callCost: (requestId) => this.generationCost(requestId),
    };
  }

  /** The base URL the SDK is given when settings name none. */
  static readonly defaultBaseURL = GATEWAY_BASE_URL;

  #client(label: string): Gateway {
    if (this.#gateway === undefined)
      throw new ProviderError(
        `gateway ${label}: ${this.#keyEnv} is not set; the gateway key must come from the environment`,
      );
    return this.#gateway;
  }

  async #guard<T>(label: string, call: (gateway: Gateway) => Promise<T>): Promise<T> {
    const gateway = this.#client(label);
    try {
      return await call(gateway);
    } catch (error) {
      throw providerFailure("gateway", label, error);
    }
  }

  /** The gateway's credit balance, in USD; spends nothing. */
  async credits(): Promise<LimitReading> {
    const credits = await this.#guard("credits", (g) => g.getCredits());
    const balanceUsd = toNumber((credits as { balance?: unknown }).balance);
    if (balanceUsd === undefined) throw new ProviderError("gateway credits: no balance returned");
    return { balanceUsd, source: "gateway credits" };
  }

  /**
   * The gateway's own cost of one generation (`getGenerationInfo`, `totalCost` in USD); spends
   * nothing. Undefined while the gateway cannot report it yet; null for an ID that is not a
   * generation ID (a response header or a local ID), which it can never look up.
   */
  async generationCost(requestId: string): Promise<number | null | undefined> {
    if (!requestId.startsWith("gen_")) return null;
    if (this.#gateway === undefined) return undefined;
    try {
      const info = await this.#gateway.getGenerationInfo({ id: requestId });
      return toNumber(info.totalCost);
    } catch {
      return undefined; // Not reported yet, or the lookup failed: retried later.
    }
  }

  async generateImage(req: ImageRequest): Promise<ImageResult> {
    const result = await this.#guard("image", (gateway) =>
      generateImage({
        model: gateway.imageModel(req.model),
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
    const meta = result.providerMetadata as Metadata;
    const gw = gatewayMeta(meta);
    const seed =
      toNumber(gw["seed"]) ??
      Object.values(meta ?? {})
        .map((entry) => toNumber(entry?.["seed"]))
        .find((s) => s !== undefined);
    const cost = toNumber(gw["cost"]);
    return {
      images: result.images.map((i) => ({ mediaType: i.mediaType, bytes: i.uint8Array })),
      ...requestId(gw["generationId"], result.responses[0]?.headers?.["x-vercel-id"]),
      ...(cost !== undefined && { costUsd: cost }),
      ...(seed !== undefined && { seed }),
    };
  }

  async analyzeImages(req: VisionRequest): Promise<VisionResult> {
    const result = await this.#guard("vision", (gateway) =>
      generateText({
        model: gateway.languageModel(req.model),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: req.prompt },
              ...req.images.map((i) => ({
                type: "image" as const,
                image: i.bytes,
                mediaType: i.mediaType,
              })),
            ],
          },
        ],
        ...(req.providerOptions !== undefined && {
          providerOptions: req.providerOptions as Record<string, never>,
        }),
      }),
    );
    const gw = gatewayMeta(result.providerMetadata as Metadata);
    const cost = toNumber(gw["cost"]);
    return {
      text: result.text,
      ...requestId(gw["generationId"], result.response.id),
      ...(cost !== undefined && { costUsd: cost }),
    };
  }

  /**
   * A typed decision through the gateway's decision models. The question is always asked under
   * the ID `answer`. Confidence is the provider's own statistic from provider metadata
   * (Perplexity and TypeSafe report one per question), when it reports one.
   */
  async decide(req: DecisionRequest): Promise<DecisionResult> {
    const q = req.question;
    const question =
      q.type === "score"
        ? { type: "score" as const, instructions: q.instructions, criteria: q.levels }
        : {
            type: "boolean" as const,
            instructions: q.instructions,
            criteria: {
              ...(q.whenTrue !== undefined && { true: q.whenTrue }),
              ...(q.whenFalse !== undefined && { false: q.whenFalse }),
            },
          };
    const result = await this.#guard("decide", (gateway) =>
      experimental_decide({
        model: gateway.decisionModel(req.model),
        state: [
          { type: "text", text: req.prompt },
          ...req.images.map((i) => ({
            type: "file" as const,
            mediaType: i.mediaType,
            data: i.bytes,
          })),
        ],
        questions: { answer: question },
        // Decision providers rate-limit tightly (#27); back off and retry rather than fail.
        maxRetries: 4,
      }),
    );
    const raw = result.answers.answer as
      | { type: "score"; score: number; probabilities?: Record<string, number> }
      | { type: "boolean"; probability: number };
    const answer: DecisionAnswer =
      raw.type === "score"
        ? {
            type: "score",
            score: raw.score,
            ...(raw.probabilities !== undefined && { probabilities: raw.probabilities }),
          }
        : { type: "boolean", probability: raw.probability };
    const meta = result.providerMetadata as Metadata;
    const confidence = Object.values(meta ?? {})
      .map((entry) => {
        const c = entry?.["confidence"];
        return toNumber(
          c !== null && typeof c === "object" ? (c as Record<string, unknown>)["answer"] : c,
        );
      })
      .find((c) => c !== undefined);
    const cost = toNumber(gatewayMeta(meta)["cost"]);
    return {
      answer,
      decisionSource: "decision-model",
      ...requestId(gatewayMeta(meta)["generationId"], result.response.id),
      ...(cost !== undefined && { costUsd: cost }),
      ...(confidence !== undefined && { confidence }),
    };
  }
}
