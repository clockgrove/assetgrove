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

import { BRIEF_POLICY_OPERATION, PROMPT_POLICY_OPERATION } from "../routes.ts";

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
  /**
   * Answers the prompt policy's model check (the `prompt-policy` decision). A script without it
   * allows every prompt (probability 0); its calls do not count toward `decide`'s index.
   */
  promptPolicy?(request: DecisionRequest): Omit<DecisionResult, "requestId"> & {
    requestId?: string;
  };
  /**
   * Answers the brief policy's model check (the `brief-policy` decisions; `briefPolicyAsked` in
   * src/policy/brief.ts reads the field and target from the prompt). A script without it finds
   * no departure (probability 0); its calls do not count toward `decide`'s index.
   */
  briefPolicy?(request: DecisionRequest): Omit<DecisionResult, "requestId"> & {
    requestId?: string;
  };
  /** Answers image-to-3D calls; a script without it cannot answer one. */
  model?(request: ModelRequest, index: number): Scripted<ModelResult>;
  /** Answers rig calls. */
  rig?(request: RigRequest, index: number): Scripted<ModelResult>;
  /** Answers clip retargeting calls. */
  animate?(request: AnimateRequest, index: number): Scripted<ModelResult>;
  /**
   * Test only: the scripted adapter marks the provider paid, so its calls count in the spend
   * ledger and need a declared limit, and tests can prove the limits offline.
   */
  paid?: boolean;
  /** Test only: the provider's limit reading, as a real adapter reads its balance. */
  limitReading?(): LimitReading | Promise<LimitReading>;
  /** Test only: how the provider's usage is reconciled, as a real adapter declares it. */
  reconcile?: Billing["reconcile"];
  /**
   * Test only: the provider's own cost of a call by its request ID, as the gateway reports it;
   * undefined while it is not reported yet.
   */
  callCost?(requestId: string): number | null | undefined | Promise<number | null | undefined>;
}

type Scripted<T extends { requestId: string }> = Omit<T, "requestId"> & { requestId?: string };

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
  private policyCount = 0;
  private briefPolicyCount = 0;

  /** Free unless the script sets `paid`; `billing` overrides the descriptor's other fields. */
  constructor(script: Script, billing?: Partial<Omit<Billing, "paid">>) {
    this.script = script;
    const read = script.limitReading?.bind(script);
    const cost = script.callCost?.bind(script);
    this.billing = {
      adapter: "scripted",
      providerId: "scripted",
      hosts: [],
      reconcile: "unavailable",
      ...billing,
      paid: script.paid === true,
      ...(script.reconcile !== undefined && { reconcile: script.reconcile }),
      ...(read !== undefined && { readLimit: async () => read() }),
      ...(cost !== undefined && { callCost: async (requestId: string) => cost(requestId) }),
    };
  }

  async generateImage(request: ImageRequest): Promise<ImageResult> {
    this.calls.push({ kind: "image", request });
    const index = this.imageCount++;
    const result = this.script.image(request, index);
    return { requestId: `scripted-image-${index}`, ...result };
  }

  async analyzeImages(request: VisionRequest): Promise<VisionResult> {
    this.calls.push({ kind: "vision", request });
    const index = this.visionCount++;
    const result = this.script.vision(request, index);
    return { requestId: `scripted-vision-${index}`, ...result };
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    this.calls.push({ kind: "decide", request });
    if (request.operation === PROMPT_POLICY_OPERATION) {
      const index = this.policyCount++;
      const answer = this.script.promptPolicy
        ? this.script.promptPolicy(request)
        : { answer: { type: "boolean" as const, probability: 0 }, costUsd: 0 };
      return { requestId: `scripted-prompt-policy-${index}`, ...answer };
    }
    if (request.operation === BRIEF_POLICY_OPERATION) {
      const index = this.briefPolicyCount++;
      const answer = this.script.briefPolicy
        ? this.script.briefPolicy(request)
        : { answer: { type: "boolean" as const, probability: 0 }, costUsd: 0 };
      return { requestId: `scripted-brief-policy-${index}`, ...answer };
    }
    const index = this.decideCount++;
    if (!this.script.decide) throw new Error("the provider script has no decide answer");
    const result = this.script.decide(request, index);
    return { requestId: `scripted-decide-${index}`, ...result };
  }

  async generateModel(request: ModelRequest): Promise<ModelResult> {
    this.calls.push({ kind: "model", request });
    const index = this.modelCount++;
    if (!this.script.model) throw new Error("the provider script has no model answer");
    return { requestId: `scripted-model-${index}`, ...this.script.model(request, index) };
  }

  async rigModel(request: RigRequest): Promise<ModelResult> {
    this.calls.push({ kind: "rig", request });
    const index = this.rigCount++;
    if (!this.script.rig) throw new Error("the provider script has no rig answer");
    return { requestId: `scripted-rig-${index}`, ...this.script.rig(request, index) };
  }

  async animateModel(request: AnimateRequest): Promise<ModelResult> {
    this.calls.push({ kind: "animate", request });
    const index = this.animateCount++;
    if (!this.script.animate) throw new Error("the provider script has no animate answer");
    return { requestId: `scripted-animate-${index}`, ...this.script.animate(request, index) };
  }
}
