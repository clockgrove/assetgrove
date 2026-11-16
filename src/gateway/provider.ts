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
  /**
   * A mask of the region to edit, in Assetgrove's region convention: opaque, light pixels are the
   * region (src/regions.ts). Sent only to a provider whose adapter declares the `mask` capability.
   */
  mask?: ImageInput;
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

/** The kind of provider call; a provider made of several adapters bills each kind to one of them. */
export type CallKind = "image" | "vision" | "decide" | "model" | "rig" | "animate" | "embed";

/** What the provider reports about the money its key can still spend. */
export interface LimitReading {
  /** The balance the provider reports, in USD; absent when it cannot be priced. */
  balanceUsd?: number;
  /** The balance in the provider's own unit, when that is not USD (Tripo credits). */
  balance?: number;
  unit?: string;
  /** Where the reading came from, for example `gateway credits`. */
  source: string;
}

/** A declared limit at the provider, as settings hold it (`providers.<id>.limit`). */
export interface DeclaredLimit {
  kind: string;
  usd?: number;
  period?: string;
  acceptUnlimited?: boolean;
}

/**
 * What a provider instance costs, decided by its adapter (src/providers/adapter.ts), never by a
 * provider's name: whether its calls are paid, the hosts it reaches, the limit the developer
 * declared for it and how to read the provider's own balance.
 */
export interface Billing {
  /** The adapter id, for example `vercel-ai-gateway`. */
  adapter: string;
  /** The settings id of the provider instance. */
  providerId: string;
  paid: boolean;
  /** The hosts its calls reach. */
  hosts: string[];
  /** The limit declared in settings, when one is. */
  limit?: DeclaredLimit;
  /** Reads the provider's balance; spends nothing. Absent where the provider offers no reading. */
  readLimit?: () => Promise<LimitReading>;
  /** How spend is reconciled with the provider: per-call cost, balance delta, or not at all. */
  reconcile: "per-call-cost" | "balance-delta" | "unavailable";
  /**
   * The provider's own cost of one call, in USD, by the request ID it returned; spends nothing.
   * Undefined while the provider has not reported it yet (the lookup stays pending); null for an ID
   * the provider can never look up. Present only where `reconcile` is `per-call-cost`.
   */
  callCost?: (requestId: string) => Promise<number | null | undefined>;
}

export interface GenerationProvider {
  /** What its calls cost and where they go, from its adapter. */
  readonly billing: Billing;
  /** The billing of one kind of call, for a provider made of several adapters. */
  billingFor?(kind: CallKind): Billing;
  generateImage(request: ImageRequest): Promise<ImageResult>;
  analyzeImages(request: VisionRequest): Promise<VisionResult>;
  /** A typed decision (Score or Boolean); providers without decision models leave it out. */
  decide?(request: DecisionRequest): Promise<DecisionResult>;
  /**
   * One embedding: an image or a text, in the one vector space the model puts both in. Providers
   * without the `embed` capability leave it out.
   */
  embed?(request: EmbedRequest): Promise<EmbedResult>;
  /** Image-to-3D: a textured model from reference images. Providers without 3D leave it out. */
  generateModel?(request: ModelRequest): Promise<ModelResult>;
  /** Rigs a model the provider made earlier (by its handle) for a gait. */
  rigModel?(request: RigRequest): Promise<ModelResult>;
  /** Retargets library clips onto a rigged model (by its handle); one model with every clip. */
  animateModel?(request: AnimateRequest): Promise<ModelResult>;
}

export interface EmbedRequest {
  model: string;
  /** One image (encoded bytes) or one text. */
  input: { image: ImageInput } | { text: string };
  /** The vector width asked for. */
  dimensions: number;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface EmbedResult extends ProviderResult {
  vector: number[];
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
  /** The operation the decision is for (`identity`, `prompt-policy`); adapters may ignore it. */
  operation?: string;
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
  /**
   * How the answer was made: a decision model's typed answer (`decision-model`), or a chat model's
   * answer constrained by structured output (`structured-output`).
   */
  decisionSource?: DecisionSource;
}

export type DecisionSource = "decision-model" | "structured-output";
