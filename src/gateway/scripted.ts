import { providerFailure } from "../limits.ts";
import type {
  AnimateRequest,
  Billing,
  CallKind,
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
   * Test only: the scripted adapter bills this script's calls as paid, so they reserve in the
   * spend ledger and need a declared limit, and tests can prove both offline.
   */
  paid?: boolean;
  /** Test only: what the provider reports about its limit, for `spend check`. */
  limitReading?(): LimitReading;
}

type Scripted<T extends { requestId: string }> = Omit<T, "requestId"> & { requestId?: string };

export class ScriptedProvider implements GenerationProvider {
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

  readonly billing: Billing;

  constructor(script: Script, billing?: Omit<Billing, "limitReading">) {
    this.script = script;
    const reader = script.limitReading?.bind(script);
    this.billing = {
      ...(billing ?? {
        adapter: "scripted",
        provider: "scripted",
        paid: script.paid === true,
        hosts: [],
      }),
      ...(reader !== undefined && { limitReading: async () => reader() }),
    };
  }

  /**
   * Runs a script answer. An error the script throws with a numeric `statusCode` (and an optional
   * provider `code`) stands in for a provider's HTTP failure and is mapped as an adapter maps one.
   */
  #answer<T>(kind: CallKind, answer: () => T): T {
    try {
      return answer();
    } catch (error) {
      const status = (error as { statusCode?: unknown } | null)?.statusCode;
      if (typeof status === "number") throw providerFailure(`scripted ${kind}`, error);
      throw error;
    }
  }

  async generateImage(request: ImageRequest): Promise<ImageResult> {
    this.calls.push({ kind: "image", request });
    const index = this.imageCount++;
    const result = this.#answer("image", () => this.script.image(request, index));
    return { requestId: `scripted-image-${index}`, ...result };
  }

  async analyzeImages(request: VisionRequest): Promise<VisionResult> {
    this.calls.push({ kind: "vision", request });
    const index = this.visionCount++;
    const result = this.#answer("vision", () => this.script.vision(request, index));
    return { requestId: `scripted-vision-${index}`, ...result };
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    this.calls.push({ kind: "decide", request });
    const index = this.decideCount++;
    if (!this.script.decide) throw new Error("the provider script has no decide answer");
    const result = this.#answer("decide", () => this.script.decide!(request, index));
    return { requestId: `scripted-decide-${index}`, ...result };
  }

  async generateModel(request: ModelRequest): Promise<ModelResult> {
    this.calls.push({ kind: "model", request });
    const index = this.modelCount++;
    if (!this.script.model) throw new Error("the provider script has no model answer");
    return { requestId: `scripted-model-${index}`, ...this.#answer("model", () => this.script.model!(request, index)) };
  }

  async rigModel(request: RigRequest): Promise<ModelResult> {
    this.calls.push({ kind: "rig", request });
    const index = this.rigCount++;
    if (!this.script.rig) throw new Error("the provider script has no rig answer");
    return { requestId: `scripted-rig-${index}`, ...this.#answer("rig", () => this.script.rig!(request, index)) };
  }

  async animateModel(request: AnimateRequest): Promise<ModelResult> {
    this.calls.push({ kind: "animate", request });
    const index = this.animateCount++;
    if (!this.script.animate) throw new Error("the provider script has no animate answer");
    return { requestId: `scripted-animate-${index}`, ...this.#answer("animate", () => this.script.animate!(request, index)) };
  }
}
