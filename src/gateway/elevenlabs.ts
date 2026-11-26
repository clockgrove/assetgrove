import { randomUUID } from "node:crypto";
import { type ElevenLabs, ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { BudgetExceededError } from "../budget.ts";
import { ProviderError } from "../errors.ts";
import { failureFacts, isQuotaRefusal, ProviderQuotaError } from "./failure.ts";
import type {
  AccountReading,
  AccountRoute,
  AudioRequest,
  AudioResult,
  Billing,
  CallKind,
  GenerationProvider,
  ImageResult,
  VisionResult,
} from "./provider.ts";

/** ElevenLabs' fixed endpoint; settings never move it. */
export const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
/** The published price of generated sound effects, in USD a minute. */
export const ELEVENLABS_USD_PER_MINUTE = 0.12;
/** The API's longest clip, in seconds; the cost of a call that asks for no duration. */
export const ELEVENLABS_MAX_DURATION_S = 30;
export const ELEVENLABS_MIN_DURATION_S = 0.5;
export const ELEVENLABS_SAMPLE_RATES = [8000, 16000, 22050, 24000, 32000, 44100, 48000] as const;
export const ELEVENLABS_DEFAULT_SAMPLE_RATE = 44100;

const PRO_TIERS = new Set(["pro", "scale", "business", "growing_business", "enterprise"]);
const PRO_RATES = new Set<number>([44100, 48000]);

function sampleRateOf(
  providerOptions: Record<string, Record<string, unknown>> | undefined,
): unknown {
  return providerOptions?.["elevenlabs"]?.["sampleRate"] ?? ELEVENLABS_DEFAULT_SAMPLE_RATE;
}

function isSampleRate(value: unknown): value is (typeof ELEVENLABS_SAMPLE_RATES)[number] {
  return ELEVENLABS_SAMPLE_RATES.some((rate) => rate === value);
}

/**
 * The ElevenLabs sound-effects adapter. It uses the official SDK (repository rule: an official SDK
 * before hand-written protocol code), given the injected guarded `fetch` so every request passes
 * the host guard, the key explicitly (the SDK never reads the environment) and retries off, so a
 * paid call is never repeated by the SDK. Its cost is the published per-minute rate; the account's
 * tier is read before a call and recorded as the call's plan.
 */
export class ElevenLabsProvider implements GenerationProvider {
  readonly billing: Billing;
  readonly audioParameters = ["durationS", "promptInfluence"] as const;
  readonly #apiKey: string | undefined;
  readonly #keyEnv: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  #client: ElevenLabsClient | undefined;
  #tier: string | undefined;

  constructor(options: {
    apiKey: string | undefined;
    keyEnv?: string;
    billing?: Omit<Billing, "hosts" | "readLimit" | "callCost">;
    /** Tests only: a loopback fixture. Settings never set it. */
    baseUrl?: string;
    fetch?: typeof fetch;
  }) {
    this.#apiKey = options.apiKey || undefined;
    this.#keyEnv = options.keyEnv ?? "ELEVENLABS_API_KEY";
    this.#baseUrl = (options.baseUrl ?? ELEVENLABS_BASE_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.billing = {
      adapter: "elevenlabs",
      providerId: "elevenlabs",
      paid: true,
      settle: "declared",
      reconcile: "unavailable",
      ...options.billing,
      hosts: [new URL(this.#baseUrl).host],
    };
  }

  generateImage(): Promise<ImageResult> {
    return Promise.reject(new ProviderError("elevenlabs's adapter serves audio only"));
  }

  analyzeImages(): Promise<VisionResult> {
    return Promise.reject(new ProviderError("elevenlabs's adapter serves audio only"));
  }

  estimate(request: AudioRequest, kind: CallKind): number {
    if (kind !== "audio") throw new ProviderError("elevenlabs's adapter serves audio only");
    const duration = request.durationS;
    if (
      duration !== undefined &&
      !(duration >= ELEVENLABS_MIN_DURATION_S && duration <= ELEVENLABS_MAX_DURATION_S)
    ) {
      throw new ProviderError(
        `elevenlabs: durationS ${duration} is outside ${ELEVENLABS_MIN_DURATION_S} to ${ELEVENLABS_MAX_DURATION_S} seconds`,
      );
    }
    return (ELEVENLABS_USD_PER_MINUTE * (duration ?? ELEVENLABS_MAX_DURATION_S)) / 60;
  }

  /** The account's tier, and why it does not allow the route when it does not; spends nothing. */
  async checkAccount(route?: AccountRoute): Promise<AccountReading> {
    const tier = await this.#readTier();
    const reading: AccountReading = { plan: tier, source: "elevenlabs subscription" };
    const refused = this.#refusal(tier, route);
    return refused === undefined ? reading : { ...reading, refused };
  }

  #refusal(tier: string, route: AccountRoute | undefined): string | undefined {
    if (tier === "free") {
      return "free plans are non-commercial only, and a sold game is commercial";
    }
    if (route === undefined) return undefined;
    const rate = sampleRateOf(route.providerOptions);
    if (!isSampleRate(rate)) {
      return `sample rate ${String(rate)} is not one ElevenLabs serves (${ELEVENLABS_SAMPLE_RATES.join(", ")})`;
    }
    if (PRO_RATES.has(rate) && !PRO_TIERS.has(tier)) {
      return `a ${rate} Hz sample rate needs the Pro plan or above, and the account is on ${tier}`;
    }
    return undefined;
  }

  async generateAudio(request: AudioRequest): Promise<AudioResult> {
    const client = this.#clientOrThrow();
    const route = {
      operation: "audio",
      model: request.model,
      ...(request.providerOptions !== undefined && { providerOptions: request.providerOptions }),
    };
    const tier = await this.#readTier();
    const refused = this.#refusal(tier, route);
    if (refused !== undefined) throw new ProviderError(`elevenlabs: ${refused}`);
    const rate = sampleRateOf(request.providerOptions) as number;
    try {
      const { data, rawResponse } = await client.textToSoundEffects
        .convert({
          text: request.prompt,
          modelId: request.model as ElevenLabs.SfxModelId,
          outputFormat: `wav_${rate}` as ElevenLabs.TextToSoundEffectsConvertRequestOutputFormat,
          ...(request.durationS !== undefined && { durationSeconds: request.durationS }),
          ...(request.promptInfluence !== undefined && {
            promptInfluence: request.promptInfluence,
          }),
        })
        .withRawResponse();
      const bytes = new Uint8Array(await new Response(data).arrayBuffer());
      const reported =
        rawResponse.headers.get("request-id") ?? rawResponse.headers.get("x-request-id");
      return {
        audio: { mediaType: "audio/wav", bytes },
        plan: tier,
        requestId: reported ?? randomUUID(),
        ...(reported === null && { requestIdSource: "local" as const }),
      };
    } catch (error) {
      throw this.#failure("sound generation", error);
    }
  }

  #clientOrThrow(): ElevenLabsClient {
    if (this.#apiKey === undefined) {
      throw new ProviderError(`elevenlabs: no API key; set ${this.#keyEnv}`);
    }
    this.#client ??= new ElevenLabsClient({
      apiKey: this.#apiKey,
      baseUrl: this.#baseUrl,
      fetch: this.#fetch,
      maxRetries: 0,
    });
    return this.#client;
  }

  async #readTier(): Promise<string> {
    const client = this.#clientOrThrow();
    if (this.#tier !== undefined) return this.#tier;
    try {
      const subscription = await client.user.subscription.get();
      if (typeof subscription.tier !== "string" || subscription.tier === "") {
        throw new ProviderError("elevenlabs subscription: no tier returned");
      }
      this.#tier = subscription.tier;
      return this.#tier;
    } catch (error) {
      throw this.#failure("subscription", error);
    }
  }

  /** The error for a failed call: status and ElevenLabs' status word, never the body or the key. */
  #failure(label: string, error: unknown): Error {
    if (error instanceof ProviderError || error instanceof BudgetExceededError) return error;
    const facts = failureFacts(error);
    const body = (error as { body?: unknown }).body;
    const detail =
      typeof body === "object" && body !== null ? (body as { detail?: unknown }).detail : undefined;
    const word =
      typeof detail === "object" && detail !== null
        ? (detail as { status?: unknown }).status
        : undefined;
    const code = typeof word === "string" && /^[\w-]{1,64}$/.test(word) ? word : undefined;
    const reason = [
      facts.status !== undefined ? `HTTP ${facts.status}` : "request failed",
      code !== undefined ? `code ${code}` : undefined,
    ]
      .filter((part) => part !== undefined)
      .join(", ");
    const message = `elevenlabs ${label}: ${reason}`;
    const quota = { ...facts, ...(code !== undefined && { code }) };
    if (isQuotaRefusal(quota)) {
      return new ProviderQuotaError(
        `refused: ${message}; the provider's own limit for this key is reached`,
        facts.status,
        code,
      );
    }
    return new ProviderError(message, {
      ...(facts.status !== undefined && { status: facts.status }),
      ...(code !== undefined && { providerCode: code }),
    });
  }
}
