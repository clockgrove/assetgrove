import type {
  AnimateRequest,
  Billing,
  LimitReading,
  ModelRequest,
  ModelResult,
  RigRequest,
  DecisionRequest,
  DecisionResult,
  EmbedRequest,
  EmbedResult,
  GenerationProvider,
  ImageRequest,
  ImageResult,
  VisionRequest,
  VisionResult,
} from "./provider.ts";

import {
  BRIEF_POLICY_OPERATION,
  CUTOUT_OPERATION,
  LOOKDEV_MARKING_OPERATION,
  MODEL3D_FACING_OPERATION,
  PROMPT_POLICY_OPERATION,
  MOTION_TEMPLATE_OPERATION,
  REFERENCE_VIEW_OPERATION,
  STYLE_OUTLIER_OPERATION,
} from "../routes.ts";

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
   * Answers the prompt policy's reading of an ambiguous name (a `prompt-policy` Choice decision:
   * `protected`, `word` or `other-name`; `nameReadingAsked` gives the term). A script without it
   * reads every such name as an ordinary word.
   */
  promptReading?(request: DecisionRequest): Omit<DecisionResult, "requestId"> & {
    requestId?: string;
  };
  /** Answers embedding calls (images and text in one space); a script without it cannot answer one. */
  embed?(request: EmbedRequest, index: number): Scripted<EmbedResult>;
  /**
   * Answers the brief policy's model check (the `brief-policy` decisions; `briefPolicyAsked` in
   * src/policy/brief.ts reads the field and target from the prompt). A script without it finds
   * no departure (probability 0); its calls do not count toward `decide`'s index.
   */
  briefPolicy?(request: DecisionRequest): Omit<DecisionResult, "requestId"> & {
    requestId?: string;
  };
  /**
   * Answers which view a 3D request's reference shows (the `reference-view` choice decision). A
   * script without it answers those from `decide`; its calls do not count toward `decide`'s index.
   */
  referenceView?(request: DecisionRequest): Omit<DecisionResult, "requestId"> & {
    requestId?: string;
  };
  /**
   * Answers which way a generated 3D model faces (the `model3d-facing` choice decision). A script
   * without it answers those from `decide`; its calls do not count toward `decide`'s index.
   */
  facing?(request: DecisionRequest): Omit<DecisionResult, "requestId"> & {
    requestId?: string;
  };
  /**
   * Answers whether a look-dev marking is kept (the `lookdev-marking` choice decision). A script
   * without it answers those from `decide`; its calls do not count toward `decide`'s index.
   */
  marking?(request: DecisionRequest): Omit<DecisionResult, "requestId"> & {
    requestId?: string;
  };
  /**
   * Answers which motion template describes an animation family (the `motion-template` choice
   * decision). A script without it refuses the call; its calls do not count toward `decide`'s index.
   */
  motionTemplate?(request: DecisionRequest): Omit<DecisionResult, "requestId"> & {
    requestId?: string;
  };
  /**
   * Answers whether a set member is drawn in a different style (the `style-outlier` Boolean
   * decision). A script without it answers those from `decide`, and one with neither answers
   * "same style" (probability 0); its calls do not count toward `decide`'s index.
   */
  styleOutlier?(request: DecisionRequest): Omit<DecisionResult, "requestId"> & {
    requestId?: string;
  };
  /**
   * Answers whether stage's cut-out lost part of the subject or kept background (the `cutout`
   * Boolean decision). A script without it answers no (probability 0); its calls do not count
   * toward `decide`'s index.
   */
  cutout?(request: DecisionRequest): Omit<DecisionResult, "requestId"> & {
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
  /**
   * Test only: narrows the capabilities the scripted adapter declares for this module (for example,
   * without `mask`).
   */
  capabilities?: string[];
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
    | { kind: "embed"; request: EmbedRequest }
  > = [];
  private embedCount = 0;
  private modelCount = 0;
  private rigCount = 0;
  private animateCount = 0;
  private readonly script: Script;
  private imageCount = 0;
  private visionCount = 0;
  private decideCount = 0;
  private styleOutlierCount = 0;
  private policyCount = 0;
  private briefPolicyCount = 0;
  private viewCount = 0;
  private facingCount = 0;
  private markingCount = 0;
  private templateCount = 0;
  private cutoutCount = 0;

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

  declares(capability: string): boolean {
    return this.script.capabilities?.includes(capability) ?? true;
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
      const answer =
        request.question.type === "choice"
          ? this.script.promptReading
            ? this.script.promptReading(request)
            : { answer: { type: "choice" as const, choice: "word" }, costUsd: 0 }
          : this.script.promptPolicy
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
    if (request.operation === REFERENCE_VIEW_OPERATION && this.script.referenceView) {
      const index = this.viewCount++;
      return {
        requestId: `scripted-reference-view-${index}`,
        ...this.script.referenceView(request),
      };
    }
    if (request.operation === MODEL3D_FACING_OPERATION && this.script.facing) {
      const index = this.facingCount++;
      return { requestId: `scripted-facing-${index}`, ...this.script.facing(request) };
    }
    if (request.operation === LOOKDEV_MARKING_OPERATION && this.script.marking) {
      const index = this.markingCount++;
      return { requestId: `scripted-marking-${index}`, ...this.script.marking(request) };
    }
    if (request.operation === MOTION_TEMPLATE_OPERATION) {
      const index = this.templateCount++;
      if (!this.script.motionTemplate)
        throw new Error("the provider script has no motionTemplate answer");
      return {
        requestId: `scripted-motion-template-${index}`,
        ...this.script.motionTemplate(request),
      };
    }
    if (
      request.operation === STYLE_OUTLIER_OPERATION &&
      (this.script.styleOutlier || !this.script.decide)
    ) {
      const index = this.styleOutlierCount++;
      return {
        requestId: `scripted-style-outlier-${index}`,
        ...(this.script.styleOutlier?.(request) ?? {
          answer: { type: "boolean" as const, probability: 0 },
          costUsd: 0,
        }),
      };
    }
    if (request.operation === CUTOUT_OPERATION) {
      const index = this.cutoutCount++;
      const answer = this.script.cutout
        ? this.script.cutout(request)
        : { answer: { type: "boolean" as const, probability: 0 }, costUsd: 0 };
      return { requestId: `scripted-cutout-${index}`, ...answer };
    }
    const index = this.decideCount++;
    if (!this.script.decide) throw new Error("the provider script has no decide answer");
    const result = this.script.decide(request, index);
    return { requestId: `scripted-decide-${index}`, ...result };
  }

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    this.calls.push({ kind: "embed", request });
    const index = this.embedCount++;
    if (!this.script.embed) throw new Error("the provider script has no embed answer");
    return { requestId: `scripted-embed-${index}`, ...this.script.embed(request, index) };
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
