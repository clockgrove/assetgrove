/**
 * The generation provider interface Assetgrove owns. The gateway adapter implements it; the
 * scripted provider implements it for tests. No provider SDK type appears here.
 */

import type { ProviderLimit } from "../settings.ts";

/** What a provider reports about its own limit or balance, read without spending. */
export interface LimitReading {
  /** Where the reading came from, for example `gateway credits` or `tripo balance`. */
  source: string;
  /** Spendable USD left, when the provider reports it in USD. */
  remainingUsd?: number;
  /** The limit itself in USD, when the provider reports one. */
  limitUsd?: number;
  /** A balance in the provider's own credits, when it reports credits. */
  credits?: number;
}

/**
 * Who bills a provider instance's calls, decided by its adapter (src/providers/adapter.ts): whether
 * they cost money, the hosts they reach, the limit the developer declared in settings and, when the
 * provider reports one, how to read it. A provider's name never decides.
 */
export interface Billing {
  adapter: string;
  /** The provider id in settings. */
  provider: string;
  paid: boolean;
  hosts: string[];
  limit?: ProviderLimit;
  limitReading?: () => Promise<LimitReading>;
}

/** The kinds of call a provider answers. */
export type CallKind = "image" | "vision" | "decide" | "model" | "rig" | "animate";

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
  /** Who bills this provider's calls; for a composite provider, its image calls'. */
  readonly billing: Billing;
  /** Every billing a composite provider's calls can carry; absent means `[billing]`. */
  readonly billings?: readonly Billing[];
  /** The billing of one kind of call, for a composite provider; absent means `billing`. */
  billingFor?(kind: CallKind): Billing;
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
