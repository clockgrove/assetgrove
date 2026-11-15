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

/** An adapter that serves only the 3D calls. */
export type ModelProvider = Pick<GenerationProvider, "generateModel" | "rigModel" | "animateModel">;

/**
 * One provider made of two adapters: image, vision and decision calls go to the gateway, 3D calls
 * to the 3D adapter. Each call is billed to the adapter that serves it (`billingFor`); `parts`
 * lists both. A missing key fails only the calls that need it, as a provider error.
 */
export class RoutedProvider implements GenerationProvider {
  readonly billing: Billing;
  readonly parts: readonly Billing[];
  private readonly gateway: GenerationProvider;
  private readonly models: ModelProvider & { billing: Billing };

  constructor(options: { gateway: GenerationProvider; models: GenerationProvider }) {
    this.gateway = options.gateway;
    this.models = options.models;
    const [a, b] = [options.models.billing, options.gateway.billing];
    this.parts = [a, b];
    this.billing = {
      adapter: `${a.adapter}+${b.adapter}`,
      providerId: `${a.providerId}+${b.providerId}`,
      paid: a.paid || b.paid,
      hosts: [...new Set([...a.hosts, ...b.hosts])],
      reconcile: "unavailable",
    };
  }

  billingFor(kind: CallKind): Billing {
    return kind === "model" || kind === "rig" || kind === "animate"
      ? this.models.billing
      : this.gateway.billing;
  }

  private image(): GenerationProvider {
    return this.gateway;
  }

  private model(): ModelProvider {
    return this.models;
  }

  generateImage(request: ImageRequest): Promise<ImageResult> {
    return this.image().generateImage(request);
  }

  analyzeImages(request: VisionRequest): Promise<VisionResult> {
    return this.image().analyzeImages(request);
  }

  decide(request: DecisionRequest): Promise<DecisionResult> {
    const provider = this.image();
    if (!provider.decide) throw new ProviderError("the gateway cannot make typed decisions");
    return provider.decide(request);
  }

  generateModel(request: ModelRequest): Promise<ModelResult> {
    const provider = this.model();
    if (!provider.generateModel) throw new ProviderError("the 3D provider cannot make models");
    return provider.generateModel(request);
  }

  rigModel(request: RigRequest): Promise<ModelResult> {
    const provider = this.model();
    if (!provider.rigModel) throw new ProviderError("the 3D provider cannot rig models");
    return provider.rigModel(request);
  }

  animateModel(request: AnimateRequest): Promise<ModelResult> {
    const provider = this.model();
    if (!provider.animateModel) throw new ProviderError("the 3D provider cannot animate models");
    return provider.animateModel(request);
  }
}
