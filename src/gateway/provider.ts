import { ProviderError, ProviderQuotaError } from "../errors.ts";

/**
 * The generation provider interface Assetgrove owns. The gateway adapter implements it; the
 * scripted provider implements it for tests. No provider SDK type appears here.
 */

export interface ImageInput {
  mediaType: string;
  bytes: Uint8Array;
}

export interface ImageRequest {
  model: string;
  prompt: string;
  /** Reference images; when present the model edits or follows them. */
  references: ImageInput[];
  size?: string;
  seed?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface ProviderResult {
  requestId: string;
  /**
   * `local` when the provider reported no request ID and the adapter generated one, so a
   * fabricated ID is never mistaken for a traceable one. Absent means the provider reported it.
   */
  requestIdSource?: "provider" | "local";
  /** The cost the provider reported, in USD, when it reports one. */
  costUsd?: number;
  /** The seed the provider used, when it reports one. */
  seed?: number;
}

export interface ImageResult extends ProviderResult {
  images: ImageInput[];
}

export interface VisionRequest {
  model: string;
  prompt: string;
  images: ImageInput[];
  /** The route's provider options, passed to the provider as given. */
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface VisionResult extends ProviderResult {
  text: string;
}

export interface GenerationProvider {
  /**
   * What the instance's calls cost, from its adapter. A provider without one (a hand-made test
   * double) counts as paid with no declared limit.
   */
  readonly billing?: Billing;
  /** The billing of the provider that serves one kind of call, when it differs by kind. */
  billingFor?(kind: CallKind): Billing | undefined;
  generateImage(request: ImageRequest): Promise<ImageResult>;
  analyzeImages(request: VisionRequest): Promise<VisionResult>;
  /** A typed decision (Score or Boolean); providers without decision models leave it out. */
  decide?(request: DecisionRequest): Promise<DecisionResult>;
  /** Image-to-3D: a textured model from reference images. Providers without 3D leave it out. */
  generateModel?(request: ModelRequest): Promise<ModelResult>;
  /** Rigs a model the provider made earlier (by its handle) for a gait. */
  rigModel?(request: RigRequest): Promise<ModelResult>;
  /** Retargets library clips onto a rigged model (by its handle); one model with every clip. */
  animateModel?(request: AnimateRequest): Promise<ModelResult>;
}

/** Reference views for image-to-3D, by the view each image shows. */
export interface ModelView extends ImageInput {
  /** `front`, `left`, `back`, `right`, or another role when the view is unknown. */
  view: string;
}

export interface ModelRequest {
  model: string;
  /** Reference images; with several named views the provider may build from all of them. */
  views: ModelView[];
  prompt?: string;
  seed?: number;
  /** The target's triangle budget; a provider that can limit its mesh should stay within it. */
  maxTriangles?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface RigRequest {
  model: string;
  /** The provider's handle of the model to rig. */
  source: string;
  /** The rig the provider fits, for example `quadruped` or `biped`. */
  rigType: string;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface AnimateRequest {
  model: string;
  /** The provider's handle of the rigged model. */
  source: string;
  /** Library clip IDs, in order; the result holds one animation per clip, in this order. */
  clips: string[];
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface ModelResult extends ProviderResult {
  /** An opaque handle a later call (rig, animate) passes back to the same provider. */
  handle: string;
  /** The model as binary glTF. */
  glb: Uint8Array;
}

/**
 * A typed decision question. `score` asks for a position on ordered levels (indexed from zero);
 * `boolean` asks for the probability that the statement is true.
 */
export type DecisionQuestion =
  | { type: "score"; instructions: string; levels: string[] }
  | { type: "boolean"; instructions: string; whenTrue?: string; whenFalse?: string };

export interface DecisionRequest {
  model: string;
  /** Text state given before the images. */
  prompt: string;
  /** Images, in the order the prompt names them. */
  images: ImageInput[];
  question: DecisionQuestion;
}

export type DecisionAnswer =
  | {
      type: "score";
      /** Fractional position in `[0, levels.length - 1]`. */
      score: number;
      /** Probability per level index, when the model reports a distribution. */
      probabilities?: Record<string, number>;
    }
  | {
      type: "boolean";
      /** The model's probability that the statement is true. */
      probability: number;
    };

export interface DecisionResult extends ProviderResult {
  answer: DecisionAnswer;
  /** The provider's own confidence statistic for the answer, when it reports one. */
  confidence?: number;
}

/** What a provider's own account reports about its limit: a balance, in USD or in credits. */
export interface LimitReading {
  /** Where the reading came from, for example `gateway credits` or `tripo balance`. */
  source: string;
  balanceUsd?: number;
  credits?: number;
}

/** A provider limit as developer settings declare it (`providers.<id>.limit`). */
export interface DeclaredLimit {
  kind: string;
  usd?: number | undefined;
  period?: string | undefined;
  acceptUnlimited?: boolean | undefined;
}

/**
 * What a provider instance's calls cost, decided by its adapter (src/providers/adapter.ts), never
 * by the provider's name: whether they are paid, the hosts they reach, the limit the developer
 * declared for it, how its usage can be reconciled and, where the provider reports one, how to
 * read its balance.
 */
export interface Billing {
  /** The adapter id, for example `vercel-ai-gateway`. */
  adapter: string;
  /** The settings provider id the instance was created for. */
  provider: string;
  paid: boolean;
  /** The hosts the instance's calls reach. */
  hosts: string[];
  limit?: DeclaredLimit;
  reconcile: "per-call" | "balance" | "unavailable";
  /** Reads the provider's own balance; spends nothing. */
  readLimit?(): Promise<LimitReading>;
}

/** The kinds of call a provider serves, for `GenerationProvider.billingFor`. */
export type CallKind = "image" | "vision" | "decide" | "model" | "rig" | "animate";

/**
 * The error an adapter throws for a failed provider call: the provider's message, HTTP status and
 * error code, and nothing else (no response body, no cause). A gateway 402 and a 429
 * `insufficient_quota` (the OpenAI quota shape) are the account's own limit: `ProviderQuotaError`,
 * exit 3 `cap_refused`.
 */
export function adapterError(error: unknown, label: string): ProviderError | ProviderQuotaError {
  if (error instanceof ProviderError || error instanceof ProviderQuotaError) return error;
  let e = record(error);
  // The AI SDK's RetryError wraps the last attempt's error.
  const last = record(e?.["lastError"]);
  if (last !== undefined && e?.["name"] === "AI_RetryError") e = last;
  const status = number(e?.["statusCode"]) ?? number(e?.["status"]);
  const data = record(record(e?.["data"])?.["error"]);
  const code =
    text(e?.["code"]) ?? text(e?.["type"]) ?? text(data?.["code"]) ?? text(data?.["type"]);
  const message =
    text(e?.["message"]) ?? (error instanceof Error ? error.message : "request failed");
  const quota = status === 402 || (status === 429 && code === "insufficient_quota");
  const options = {
    ...(status !== undefined && { status }),
    ...(code !== undefined && { providerCode: code }),
  };
  const full = `${label}: ${message}${status !== undefined ? ` (HTTP ${status})` : ""}`;
  return quota ? new ProviderQuotaError(full, options) : new ProviderError(full, options);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value !== "" ? value : undefined;
}
