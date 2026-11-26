import { randomUUID } from "node:crypto";
import { ProviderError } from "../errors.ts";
import { isQuotaRefusal, ProviderQuotaError } from "./failure.ts";
import type {
  AudioRequest,
  AudioResult,
  Billing,
  CallKind,
  GenerationProvider,
  ImageResult,
  JobStatus,
  LimitReading,
  ProviderJobs,
  VisionResult,
} from "./provider.ts";

/** Stability's fixed endpoint; settings never move it. */
export const STABILITY_BASE_URL = "https://api.stability.ai";

/** Credits Stability charges for one successful generation; failures are not charged. */
const CREDITS_PER_GENERATION = 8;
/** The published price of one credit, in USD. */
const DEFAULT_USD_PER_CREDIT = 0.01;

const MODELS = {
  "stable-audio-2.5": { path: "/v2beta/audio/stable-audio-2/text-to-audio", maxS: 190 },
  "stable-audio-3.0": { path: "/v2beta/audio/stable-audio-3/text-to-audio", maxS: 380 },
} as const;
type Model = keyof typeof MODELS;

function isModel(model: string): model is Model {
  return Object.hasOwn(MODELS, model);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The Stability audio adapter: Stable Audio 2.5 (one synchronous call) and 3.0 (a job with an id,
 * results kept 24 h). Stability publishes no official JavaScript SDK for its REST API (its only
 * SDK, the Python `stability-sdk`, targets the retired gRPC API), so this adapter speaks the
 * documented REST API directly over the injected `fetch`; the exception is recorded in
 * docs/decisions.md. A successful call costs 8 credits × `usdPerCredit` (default the published
 * $0.01). Stability takes no idempotency key and cannot look a job up by one, so the jobs declare
 * neither `dedupesByKey` nor `find`.
 */
export class StabilityProvider implements GenerationProvider {
  readonly billing: Billing;
  readonly audioParameters = ["durationS", "seed"] as const;
  readonly #apiKey: string | undefined;
  readonly #keyEnv: string;
  readonly #rate: number;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #pollIntervalMs: number;
  readonly #timeoutMs: number;
  /** Finished 3.0 results fetched by `status`, so `result` does not download twice. */
  readonly #finished = new Map<string, Response>();

  constructor(options: {
    apiKey: string | undefined;
    keyEnv?: string;
    /** USD per Stability credit, from settings (`providers.<id>.usdPerCredit`). */
    usdPerCredit?: number;
    billing?: Omit<Billing, "hosts" | "readLimit" | "callCost">;
    /** Tests only: a loopback fixture. Settings never set it. */
    baseUrl?: string;
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    pollIntervalMs?: number;
    timeoutMs?: number;
  }) {
    this.#apiKey = options.apiKey || undefined;
    this.#keyEnv = options.keyEnv ?? "STABILITY_API_KEY";
    this.#rate = options.usdPerCredit ?? DEFAULT_USD_PER_CREDIT;
    this.#baseUrl = (options.baseUrl ?? STABILITY_BASE_URL).replace(/\/+$/, "");
    this.billing = {
      adapter: "stability",
      providerId: "stability",
      paid: true,
      settle: "reported",
      reconcile: "unavailable",
      ...options.billing,
      hosts: [new URL(this.#baseUrl).host],
      readLimit: () => this.limitReading(),
    };
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.#timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
  }

  generateImage(): Promise<ImageResult> {
    return Promise.reject(new ProviderError("stability's adapter serves audio only"));
  }

  analyzeImages(): Promise<VisionResult> {
    return Promise.reject(new ProviderError("stability's adapter serves audio only"));
  }

  /** The account's credit balance as a limit reading; spends nothing. */
  async limitReading(): Promise<LimitReading> {
    const response = await this.#send("balance", "GET", "/v1/user/balance", "application/json");
    const json: unknown = await response.json().catch(() => undefined);
    const credits = isRecord(json) ? json["credits"] : undefined;
    if (typeof credits !== "number")
      throw new ProviderError("stability balance: no credits returned");
    return {
      balance: credits,
      unit: "credits",
      balanceUsd: credits * this.#rate,
      source: "stability balance",
    };
  }

  /** The call's cost in USD, checked before core reserves: an unknown model or duration refuses. */
  estimate(request: Parameters<NonNullable<GenerationProvider["estimate"]>>[0], kind: CallKind) {
    if (kind !== "audio") throw new ProviderError("stability's adapter serves audio only");
    this.#check(request as AudioRequest);
    return this.#cost();
  }

  readonly jobs: ProviderJobs = {
    audio: {
      serves: (request) => request.model === "stable-audio-3.0",
      submit: (request) => this.#submit(request),
      status: (id) => this.#status(id),
      result: (id, request) => this.#collect(id, request),
    },
  };

  async generateAudio(request: AudioRequest): Promise<AudioResult> {
    const model = this.#check(request);
    if (model === "stable-audio-2.5") {
      const response = await this.#send(
        "audio",
        "POST",
        MODELS[model].path,
        "audio/*",
        this.#form(request),
      );
      return this.#audio(response, request, undefined);
    }
    const id = await this.#submit(request);
    let waited = 0;
    for (;;) {
      if ((await this.#status(id)) === "done") return this.#collect(id, request);
      if (waited >= this.#timeoutMs)
        throw new ProviderError(`stability audio: job ${id} timed out after ${waited} ms`);
      await this.#sleep(this.#pollIntervalMs);
      waited += this.#pollIntervalMs;
    }
  }

  #cost(): number {
    return CREDITS_PER_GENERATION * this.#rate;
  }

  #check(request: AudioRequest): Model {
    if (!isModel(request.model))
      throw new ProviderError(
        `stability: unknown audio model "${request.model}"; use stable-audio-2.5 or stable-audio-3.0`,
      );
    const max = MODELS[request.model].maxS;
    const d = request.durationS;
    if (d !== undefined && !(Number.isFinite(d) && d >= 1 && d <= max))
      throw new ProviderError(
        `stability: ${request.model} makes 1 to ${max} seconds, not ${String(d)}`,
      );
    return request.model;
  }

  #form(request: AudioRequest): FormData {
    const form = new FormData();
    form.append("prompt", request.prompt);
    form.append("model", request.model);
    form.append("output_format", "wav");
    if (request.durationS !== undefined) form.append("duration", String(request.durationS));
    if (request.seed !== undefined) form.append("seed", String(request.seed));
    return form;
  }

  async #submit(request: AudioRequest): Promise<string> {
    const model = this.#check(request);
    const response = await this.#send(
      "audio",
      "POST",
      MODELS[model].path,
      "application/json",
      this.#form(request),
    );
    const json: unknown = await response.json().catch(() => undefined);
    const id = isRecord(json) ? json["id"] : undefined;
    if (typeof id !== "string" || id === "")
      throw new ProviderError("stability audio: no job id returned");
    return id;
  }

  async #status(id: string): Promise<JobStatus> {
    const response = await this.#fetchResult(id);
    if (response.status === 202) return "running";
    if (response.status === 404) return "unknown";
    if (response.ok) {
      this.#finished.set(id, response);
      return "done";
    }
    // Any other answer (429, 401, 5xx) says nothing about the job itself, which may still
    // finish and be charged: throw, so core keeps the job journaled for the next run rather
    // than settle it and submit again.
    throw await this.#failure("audio", response);
  }

  async #collect(id: string, request: AudioRequest): Promise<AudioResult> {
    const cached = this.#finished.get(id);
    this.#finished.delete(id);
    const response = cached ?? (await this.#fetchResult(id));
    if (response.status === 202) throw new ProviderError(`stability audio: job ${id} is not done`);
    if (!response.ok) throw await this.#failure("audio", response);
    return this.#audio(response, request, id);
  }

  #fetchResult(id: string): Promise<Response> {
    return this.#request("audio", "GET", `/v2beta/results/${encodeURIComponent(id)}`, "audio/*");
  }

  async #audio(
    response: Response,
    request: AudioRequest,
    jobId: string | undefined,
  ): Promise<AudioResult> {
    if (response.headers.get("finish-reason") === "CONTENT_FILTERED")
      throw new ProviderError("stability audio: the output was filtered (CONTENT_FILTERED)", {
        providerCode: "CONTENT_FILTERED",
      });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const mediaType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
    const header = response.headers.get("seed");
    const seed = header !== null && /^\d+$/.test(header) ? Number(header) : undefined;
    const reported = response.headers.get("x-request-id") ?? response.headers.get("request-id");
    const requestId = jobId ?? reported ?? randomUUID();
    const provider = jobId !== undefined || reported !== null;
    return {
      audio: { mediaType: mediaType || "audio/wav", bytes },
      requestId,
      requestIdSource: provider ? "provider" : "local",
      costUsd: this.#cost(),
      ...(seed !== undefined ? { seed } : request.seed !== undefined && { seed: request.seed }),
    };
  }

  /** A request whose error statuses stay the caller's to read; transport failures are thrown. */
  async #request(
    label: string,
    method: string,
    path: string,
    accept: string,
    body?: FormData,
  ): Promise<Response> {
    if (this.#apiKey === undefined)
      throw new ProviderError(`stability ${label}: ${this.#keyEnv} is not set`);
    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.#apiKey}`, Accept: accept },
        ...(body !== undefined && { body }),
      });
    } catch (error) {
      throw new ProviderError(`stability ${label}: request failed`, { cause: error });
    }
  }

  /** A request that must succeed; 202 passes for the poll's caller. */
  async #send(
    label: string,
    method: string,
    path: string,
    accept: string,
    body?: FormData,
  ): Promise<Response> {
    const response = await this.#request(label, method, path, accept, body);
    if (!response.ok) throw await this.#failure(label, response);
    return response;
  }

  /** Only Stability's `name`, its `errors` and the status; never the rest of the body. */
  async #failure(label: string, response: Response): Promise<Error> {
    const json: unknown = await response.json().catch(() => undefined);
    const name = isRecord(json) && typeof json["name"] === "string" ? json["name"] : undefined;
    const errors =
      isRecord(json) && Array.isArray(json["errors"])
        ? json["errors"].filter((e): e is string => typeof e === "string")
        : [];
    const message = errors.length > 0 ? errors.join("; ") : "request failed";
    const text = `stability ${label}: ${message} (HTTP ${response.status}${name ? `, ${name}` : ""})`;
    if (isQuotaRefusal({ message, status: response.status }) || response.status === 429)
      return new ProviderQuotaError(`refused: ${text}`, response.status, name);
    return new ProviderError(text, {
      status: response.status,
      ...(name !== undefined && { providerCode: name }),
    });
  }
}
