import { ProviderError } from "../errors.ts";
import type {
  AnimateRequest,
  Billing,
  CallKind,
  DecisionRequest,
  DecisionResult,
  GenerationProvider,
  ImageRequest,
  ImageResult,
  ModelRequest,
  ModelResult,
  RigRequest,
  VisionRequest,
  VisionResult,
} from "./provider.ts";

/** An adapter instance that serves only the 3D calls. */
export type ModelProvider = Pick<
  GenerationProvider,
  "billing" | "generateModel" | "rigModel" | "animateModel"
>;

const MODEL_CALLS = new Set<CallKind>(["model", "rig", "animate"]);

/**
 * One provider made of two adapter instances: image, vision and decision calls go to the gateway,
 * 3D calls to the 3D adapter, and each call is billed by the instance that serves it. A missing key
 * fails only the calls that need it (as a provider error).
 */
export class RoutedProvider implements GenerationProvider {
  private readonly gateway: GenerationProvider;
  private readonly models: ModelProvider;
  readonly billing: Billing;
  readonly billings: readonly Billing[];

  constructor(options: { gateway: GenerationProvider; models: ModelProvider }) {
    this.gateway = options.gateway;
    this.models = options.models;
    this.billing = options.gateway.billing;
    this.billings = [options.gateway.billing, options.models.billing];
  }

  billingFor(kind: CallKind): Billing {
    return MODEL_CALLS.has(kind) ? this.models.billing : this.gateway.billing;
  }

  generateImage(request: ImageRequest): Promise<ImageResult> {
    return this.gateway.generateImage(request);
  }

  analyzeImages(request: VisionRequest): Promise<VisionResult> {
    return this.gateway.analyzeImages(request);
  }

  decide(request: DecisionRequest): Promise<DecisionResult> {
    if (!this.gateway.decide) throw new ProviderError("the gateway cannot make typed decisions");
    return this.gateway.decide(request);
  }

  generateModel(request: ModelRequest): Promise<ModelResult> {
    if (!this.models.generateModel) throw new ProviderError("the 3D provider cannot make models");
    return this.models.generateModel(request);
  }

  rigModel(request: RigRequest): Promise<ModelResult> {
    if (!this.models.rigModel) throw new ProviderError("the 3D provider cannot rig models");
    return this.models.rigModel(request);
  }

  animateModel(request: AnimateRequest): Promise<ModelResult> {
    if (!this.models.animateModel) throw new ProviderError("the 3D provider cannot animate models");
    return this.models.animateModel(request);
  }
}
