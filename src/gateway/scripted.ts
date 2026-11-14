import { adapterError } from "./provider.ts";
import type {
  AnimateRequest,
  Billing,
  LimitReading,
  ModelRequest,
  ModelResult,
  RigRequest,
  DecisionRequest,
  DecisionResult,
  GenerationProvider,
  ImageRequest,
  ImageResult,
  VisionRequest,
  VisionResult,
} from "./provider.ts";

/**
 * A scripted generation provider for tests and offline runs. It never calls a model: each call is
 * answered by the script, and every request is kept in `calls` so tests can inspect it.
 */
export interface Script {
  image(
    request: ImageRequest,
    index: number,
  ): Omit<ImageResult, "requestId"> & { requestId?: string };
  vision(
    request: VisionRequest,
    index: number,
  ): Omit<VisionResult, "requestId"> & { requestId?: string };
  /** Answers typed decision calls; a script without it cannot answer one. */
  decide?(
    request: DecisionRequest,
    index: number,
  ): Omit<DecisionResult, "requestId"> & { requestId?: string };
  /** Answers image-to-3D calls; a script without it cannot answer one. */
  model?(request: ModelRequest, index: number): Scripted<ModelResult>;
  /** Answers rig calls. */
  rig?(request: RigRequest, index: number): Scripted<ModelResult>;
  /** Answers clip retargeting calls. */
  animate?(request: AnimateRequest, index: number): Scripted<ModelResult>;
  /**
   * Test only: the scripted adapter's billing marks the calls paid, so they count in the spend
   * ledger and need a declared provider limit, and tests can prove both offline.
   */
  paid?: boolean;
  /** Test only: the balance `spend check` reads, standing in for a provider's limit reader. */
  limitReading?(): Omit<LimitReading, "source"> & { source?: string };
}

type Scripted<T extends { requestId: string }> = Omit<T, "requestId"> & { requestId?: string };

/**
 * A script's thrown error that carries an HTTP `status` (or `statusCode`) stands in for a
 * provider's error and is mapped as an adapter maps one (a 402 is a quota refusal); any other
 * error is left as thrown.
 */
function scripted<T>(answer: () => T): T {
  try {
    return answer();
  } catch (error) {
    const e = error as { status?: unknown; statusCode?: unknown } | null;
    if (typeof e?.status === "number" || typeof e?.statusCode === "number")
      throw adapterError(error, "scripted");
    throw error;
  }
}

export class ScriptedProvider implements GenerationProvider {
  readonly billing: Billing;
  readonly calls: Array<
    | { kind: "image"; request: ImageRequest }
    | { kind: "vision"; request: VisionRequest }
    | { kind: "decide"; request: DecisionRequest }
    | { kind: "model"; request: ModelRequest }
    | { kind: "rig"; request: RigRequest }
    | { kind: "animate"; request: AnimateRequest }
  > = [];
  private modelCount = 0;
  private rigCount = 0;
  private animateCount = 0;
  private readonly script: Script;
  private imageCount = 0;
  private visionCount = 0;
  private decideCount = 0;

  constructor(script: Script, billing?: Partial<Pick<Billing, "provider" | "limit">>) {
    this.script = script;
    const reading = script.limitReading?.bind(script);
    this.billing = {
      adapter: "scripted",
      provider: "scripted",
      paid: script.paid === true,
      hosts: [],
      reconcile: "unavailable",
      ...(reading && { readLimit: async () => ({ source: "script", ...reading() }) }),
      ...billing,
    };
  }

  async generateImage(request: ImageRequest): Promise<ImageResult> {
    this.calls.push({ kind: "image", request });
    const index = this.imageCount++;
    const result = scripted(() => this.script.image(request, index));
    return { requestId: `scripted-image-${index}`, ...result };
  }

  async analyzeImages(request: VisionRequest): Promise<VisionResult> {
    this.calls.push({ kind: "vision", request });
    const index = this.visionCount++;
    const result = scripted(() => this.script.vision(request, index));
    return { requestId: `scripted-vision-${index}`, ...result };
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    this.calls.push({ kind: "decide", request });
    const index = this.decideCount++;
    if (!this.script.decide) throw new Error("the provider script has no decide answer");
    const result = scripted(() => this.script.decide!(request, index));
    return { requestId: `scripted-decide-${index}`, ...result };
  }

  async generateModel(request: ModelRequest): Promise<ModelResult> {
    this.calls.push({ kind: "model", request });
    const index = this.modelCount++;
    if (!this.script.model) throw new Error("the provider script has no model answer");
    return {
      requestId: `scripted-model-${index}`,
      ...scripted(() => this.script.model!(request, index)),
    };
  }

  async rigModel(request: RigRequest): Promise<ModelResult> {
    this.calls.push({ kind: "rig", request });
    const index = this.rigCount++;
    if (!this.script.rig) throw new Error("the provider script has no rig answer");
    return {
      requestId: `scripted-rig-${index}`,
      ...scripted(() => this.script.rig!(request, index)),
    };
  }

  async animateModel(request: AnimateRequest): Promise<ModelResult> {
    this.calls.push({ kind: "animate", request });
    const index = this.animateCount++;
    if (!this.script.animate) throw new Error("the provider script has no animate answer");
    return {
      requestId: `scripted-animate-${index}`,
      ...scripted(() => this.script.animate!(request, index)),
    };
  }
}
