import type { Budget } from "./budget.ts";
import { ConfirmationError } from "./approvals.ts";
import { ProviderError } from "./errors.ts";
import { BudgetExceededError } from "./budget.ts";
import { assertLimitDeclared, billingOf } from "./limits.ts";
import type {
  CallKind,
  DecisionQuestion,
  DecisionResult,
  EmbedResult,
  GenerationProvider,
  ImageInput,
  ModelResult,
  ProviderResult,
} from "./gateway/provider.ts";
import { ProviderSet } from "./providers/set.ts";
import { currentRunScope } from "./runs/journal.ts";
import { RouteUnavailableError } from "./routes.ts";
import type { Route, Routes } from "./routes.ts";
import type { CallRecord, DecisionLog, LoadedReference } from "./types.ts";

/**
 * Budgeted, recorded provider calls. Each call reserves its route's estimate against the run's cap
 * (and the budget's cross-run spend ledger, src/spend.ts) before it reaches the provider, then settles with the provider's reported cost (or the estimate)
 * and appends a provenance record.
 *
 * Inside a paid command's run (src/runs/execute.ts) each call first checks the run's journal
 * (`calls/<callKey>.json`): a hit reserves nothing, counts its recorded cost against the run's
 * cap and returns the stored result; an answered call is journaled before it is returned.
 *
 * A paid call (its adapter's `billing.paid`) that is not a journal hit needs the run's clearance,
 * which only the executor builds from a verified confirmation; without one it exits 8.
 */
export class Caller {
  readonly records: CallRecord[] = [];
  private readonly provider: GenerationProvider;
  private readonly providerName: string | undefined;
  private readonly budget: Budget;
  private readonly routes: Routes;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly index: number | undefined;

  constructor(options: {
    /** A `ProviderSet` serves each call on its route's provider; any other provider serves all. */
    provider: GenerationProvider;
    /** The id a single provider's calls are recorded under; a set records each route's provider. */
    providerName?: string;
    budget: Budget;
    routes: Routes;
    now?: () => Date;
    /** Receives one line per typed decision call: label, confidence, latency and cost. */
    log?: (message: string) => void;
    /** The candidate or frame index these calls are for, part of each call's journal key. */
    index?: number;
  }) {
    this.provider = options.provider;
    this.providerName = options.providerName;
    this.budget = options.budget;
    this.routes = options.routes;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
    this.index = options.index;
  }

  route(operation: string): Route {
    const route = this.routes[operation];
    if (!route) {
      throw new RouteUnavailableError(
        operation,
        `route unavailable: no model route for operation "${operation}"`,
      );
    }
    return route;
  }

  /** The provider that serves a route, and the id its call is recorded under. */
  private serve(route: Route, operation: string): { provider: GenerationProvider; id: string } {
    if (this.provider instanceof ProviderSet) return this.provider.serve(route, operation);
    return { provider: this.provider, id: this.providerName ?? route.provider ?? "provider" };
  }

  private async record<T extends ProviderResult>(
    kind: CallKind,
    operation: string,
    prompt: string,
    references: LoadedReference[],
    parameters: Record<string, unknown>,
    seed: number | undefined,
    run: (route: Route, provider: GenerationProvider) => Promise<T>,
  ): Promise<T> {
    const route = this.route(operation);
    if ((kind === "image" || kind === "model") && this.provider instanceof ProviderSet)
      this.provider.checkPrompt(prompt, operation);
    const served = this.serve(route, operation);
    const name = `${served.id}:${operation}:${route.model}`;
    const scope = currentRunScope();
    const journal = scope?.journal;
    const callKey = journal?.key({
      operation,
      provider: served.id,
      model: route.model,
      prompt,
      referenceHashes: references.map((r) => r.sha256),
      ...(seed !== undefined && { seed }),
      ...(this.index !== undefined && { index: this.index }),
      ...(route.keyedProviderOptions !== undefined && {
        providerOptions: route.keyedProviderOptions,
      }),
    });
    const journaled = callKey === undefined ? undefined : journal?.read(callKey);
    if (journaled !== undefined) {
      // Answered before in this run: nothing is reserved or paid again.
      this.budget.addPrior(journaled.record.costUsd, `the journaled ${operation} call`);
      this.records.push(journaled.record);
      scope?.onCall?.({ operation, reused: true });
      return journaled.result as T;
    }
    // Paid-ness is the adapter's: only a paid call needs a declared limit and reaches the ledger.
    const billing = billingOf(served.provider, kind);
    assertLimitDeclared(billing);
    // Checked where money is spent: a paid call needs the clearance the executor built (exit 8).
    if (billing.paid && scope?.clearance === undefined)
      throw new ConfirmationError(
        "confirmation_required",
        `refused: the paid ${operation} call has no confirmed spend; run it through its command, which asks a person or reads their confirmation`,
      );
    const reservation = this.budget.reserve(
      route.estimatedCostUsd,
      `the ${operation} call`,
      billing.paid ? name : undefined,
      {
        provider: served.id,
        ...(journal !== undefined && { runId: journal.runId }),
        ...(callKey !== undefined && { callKey }),
      },
    );
    const startedAt = this.now().toISOString();
    let result: T;
    try {
      result = await run(route, served.provider);
    } catch (error) {
      // A failed call may still have been billed; count the estimate so the cap stays safe.
      this.budget.settle(reservation, route.estimatedCostUsd);
      if (error instanceof ProviderError || error instanceof BudgetExceededError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderError(`the ${operation} call failed: ${message}`, { cause: error });
    }
    const costUsd = result.costUsd ?? route.estimatedCostUsd;
    // The provider's own request ID ties the ledger entry to the provider's usage (reconcile).
    const providerId = result.requestIdSource === "local" ? undefined : result.requestId;
    this.budget.settle(reservation, costUsd, providerId);
    const usedSeed = result.seed ?? seed;
    const record: CallRecord = {
      operation,
      model: route.model,
      route: name,
      prompt,
      parameters,
      referenceHashes: references.map((r) => r.sha256),
      ...(usedSeed !== undefined && { seed: usedSeed }),
      requestId: result.requestId,
      requestIdSource: result.requestIdSource ?? "provider",
      startedAt,
      finishedAt: this.now().toISOString(),
      costUsd,
      costSource: result.costUsd === undefined ? "estimate" : "provider",
      ...(route.providerTerms !== undefined && { providerTerms: route.providerTerms }),
      ...(route.providerTermsAsOf !== undefined && {
        providerTermsAsOf: route.providerTermsAsOf,
      }),
      ...(route.outputGrant !== undefined && { outputGrant: structuredClone(route.outputGrant) }),
    };
    this.records.push(record);
    if (journal !== undefined && callKey !== undefined) {
      journal.write({
        callKey,
        operation,
        provider: served.id,
        model: route.model,
        record,
        result,
      });
      scope?.onCall?.({ operation, reused: false });
    }
    return result;
  }

  /** An image generation or reference-guided edit; references are sent in order. */
  async image(
    operation: string,
    prompt: string,
    references: LoadedReference[],
    seed?: number,
    options: { mask?: LoadedReference } = {},
  ): Promise<ImageInput> {
    const { mask } = options;
    const route = this.route(operation);
    const sendSeed = route.supportsSeed ? seed : undefined;
    const parameters: Record<string, unknown> = {
      ...(route.size !== undefined && { size: route.size }),
      ...(sendSeed !== undefined && { seed: sendSeed }),
      ...(route.providerOptions !== undefined && { providerOptions: route.providerOptions }),
      references: references.map((r) => ({ role: r.role, path: r.path, sha256: r.sha256 })),
      ...(mask !== undefined && { mask: { path: mask.path, sha256: mask.sha256 } }),
    };
    const result = await this.record(
      "image",
      operation,
      prompt,
      // The mask is hashed with the references, so a different mask is a different call.
      mask === undefined ? references : [...references, mask],
      parameters,
      sendSeed,
      (r, provider) =>
        provider.generateImage({
          model: r.model,
          prompt,
          references: references.map((ref) => ({ mediaType: ref.mediaType, bytes: ref.bytes })),
          ...(mask !== undefined && { mask: { mediaType: mask.mediaType, bytes: mask.bytes } }),
          ...(r.size !== undefined && { size: r.size }),
          ...(sendSeed !== undefined && { seed: sendSeed }),
          ...(r.providerOptions !== undefined && { providerOptions: r.providerOptions }),
        }),
    );
    const image = result.images[0];
    if (!image) throw new ProviderError(`the ${operation} call returned no image`);
    return image;
  }

  /**
   * Image-to-3D from reference views. Each reference's `view` is sent as the view it shows; the result's
   * handle lets a later rig call name the model.
   */
  async model3d(
    operation: string,
    prompt: string,
    views: Array<LoadedReference & { view: string }>,
    seed?: number,
    maxTriangles?: number,
  ): Promise<ModelResult> {
    const route = this.route(operation);
    const sendSeed = route.supportsSeed ? seed : undefined;
    const parameters: Record<string, unknown> = {
      ...(sendSeed !== undefined && { seed: sendSeed }),
      ...(maxTriangles !== undefined && { maxTriangles }),
      ...(route.providerOptions !== undefined && { providerOptions: route.providerOptions }),
      views: views.map((r) => ({ view: r.view, role: r.role, path: r.path, sha256: r.sha256 })),
    };
    return this.record("model", operation, prompt, views, parameters, sendSeed, (r, provider) => {
      const generate = provider.generateModel?.bind(provider);
      if (!generate) throw new ProviderError(`the provider cannot make 3D models (${operation})`);
      return generate({
        model: r.model,
        prompt,
        views: views.map((v) => ({ view: v.view, mediaType: v.mediaType, bytes: v.bytes })),
        ...(sendSeed !== undefined && { seed: sendSeed }),
        ...(maxTriangles !== undefined && { maxTriangles }),
        ...(r.providerOptions !== undefined && { providerOptions: r.providerOptions }),
      });
    });
  }

  /** Rigs a model the provider made (by its handle) with the given rig type. */
  async rig3d(operation: string, source: string, rigType: string): Promise<ModelResult> {
    const route = this.route(operation);
    const parameters: Record<string, unknown> = {
      source,
      rigType,
      ...(route.providerOptions !== undefined && { providerOptions: route.providerOptions }),
    };
    return this.record(
      "rig",
      operation,
      `rig: ${rigType}`,
      [],
      parameters,
      undefined,
      (r, provider) => {
        const rig = provider.rigModel?.bind(provider);
        if (!rig) throw new ProviderError(`the provider cannot rig 3D models (${operation})`);
        return rig({
          model: r.model,
          source,
          rigType,
          ...(r.providerOptions !== undefined && { providerOptions: r.providerOptions }),
        });
      },
    );
  }

  /** Retargets library clips onto a rigged model (by its handle). */
  async clips3d(operation: string, source: string, clips: string[]): Promise<ModelResult> {
    const route = this.route(operation);
    const parameters: Record<string, unknown> = {
      source,
      clips,
      ...(route.providerOptions !== undefined && { providerOptions: route.providerOptions }),
    };
    return this.record(
      "animate",
      operation,
      `clips: ${clips.join(", ")}`,
      [],
      parameters,
      undefined,
      (r, provider) => {
        const animate = provider.animateModel?.bind(provider);
        if (!animate)
          throw new ProviderError(`the provider cannot animate 3D models (${operation})`);
        return animate({
          model: r.model,
          source,
          clips,
          ...(r.providerOptions !== undefined && { providerOptions: r.providerOptions }),
        });
      },
    );
  }

  /**
   * One embedding of an image or a text on the operation's route (design section 7.7), at
   * `dimensions` wide. An image's journal key is its sha256, a text's its own text, so a resumed
   * run pays for neither twice.
   */
  async embed(
    operation: string,
    input: { image: LoadedReference } | { text: string },
    dimensions: number,
  ): Promise<number[]> {
    const route = this.route(operation);
    const images = "image" in input ? [input.image] : [];
    const prompt = "text" in input ? input.text : "";
    const parameters: Record<string, unknown> = {
      dimensions,
      input: "image" in input ? "image" : "text",
      ...(route.providerOptions !== undefined && { providerOptions: route.providerOptions }),
      ...("image" in input && { image: { path: input.image.path, sha256: input.image.sha256 } }),
    };
    const result: EmbedResult = await this.record(
      "embed",
      operation,
      prompt,
      images,
      parameters,
      undefined,
      (r, provider) => {
        const embed = provider.embed?.bind(provider);
        if (!embed) throw new ProviderError(`the provider cannot embed (${operation})`);
        return embed({
          model: r.model,
          input:
            "image" in input
              ? { image: { mediaType: input.image.mediaType, bytes: input.image.bytes } }
              : { text: input.text },
          dimensions,
          ...(r.providerOptions !== undefined && { providerOptions: r.providerOptions }),
        });
      },
    );
    if (result.vector.length !== dimensions)
      throw new ProviderError(
        `the ${operation} call returned ${result.vector.length} dimensions, not ${dimensions}; route it to a model that gives ${dimensions}`,
      );
    return result.vector;
  }

  /** A vision-model analysis of images; returns the model's text. */
  async vision(operation: string, prompt: string, images: LoadedReference[]): Promise<string> {
    const route = this.route(operation);
    const parameters = {
      ...(route.providerOptions !== undefined && { providerOptions: route.providerOptions }),
      images: images.map((r) => ({ role: r.role, path: r.path, sha256: r.sha256 })),
    };
    const result = await this.record(
      "vision",
      operation,
      prompt,
      images,
      parameters,
      undefined,
      (r, provider) =>
        provider.analyzeImages({
          model: r.model,
          prompt,
          images: images.map((ref) => ({ mediaType: ref.mediaType, bytes: ref.bytes })),
          ...(r.providerOptions !== undefined && { providerOptions: r.providerOptions }),
        }),
    );
    return result.text;
  }

  /**
   * A typed decision (Score, Boolean or Choice) about images. The call record carries the decision's
   * label, normalised value, confidence and latency, and one log line reports them with the cost.
   */
  async decide(
    operation: string,
    prompt: string,
    images: LoadedReference[],
    question: DecisionQuestion,
  ): Promise<{ result: DecisionResult; record: CallRecord }> {
    const parameters = {
      question,
      images: images.map((r) => ({ role: r.role, path: r.path, sha256: r.sha256 })),
    };
    const started = performance.now();
    let result: DecisionResult;
    try {
      result = await this.record(
        "decide",
        operation,
        prompt,
        images,
        parameters,
        undefined,
        (r, provider) => {
          const decide = provider.decide?.bind(provider);
          if (!decide)
            throw new ProviderError(`the provider cannot make typed decisions (${operation})`);
          return decide({
            model: r.model,
            prompt,
            images: images.map((ref) => ({ mediaType: ref.mediaType, bytes: ref.bytes })),
            question,
            operation,
          });
        },
      );
    } catch (error) {
      // A failed call is charged its route's estimate (see record); log it like a completed one.
      const route = Object.hasOwn(this.routes, operation) ? this.routes[operation] : undefined;
      const message = error instanceof Error ? error.message : String(error);
      const latencyMs = Math.round(performance.now() - started);
      this.log(
        `${operation} ${route?.model ?? "(no route)"}: failed (${latencyMs} ms` +
          `${route ? `, $${route.estimatedCostUsd.toFixed(6)} estimate` : ""}): ${message}`,
      );
      throw error;
    }
    const record = this.records[this.records.length - 1] as CallRecord;
    try {
      record.decision = decisionLog(
        question,
        result,
        Math.round(performance.now() - started),
        `${operation} (${record.model})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(
        `${operation} ${record.model}: failed ($${record.costUsd.toFixed(6)} ${record.costSource}): ${message}`,
      );
      throw error;
    }
    const d = record.decision;
    this.log(
      `${operation} ${record.model}: ${d.label} (value ${d.value !== undefined ? d.value.toFixed(3) : "not reported"}` +
        `${d.confidence !== undefined ? `, confidence ${d.confidence.toFixed(2)}` : ""}` +
        `, ${d.latencyMs} ms, $${record.costUsd.toFixed(6)} ${record.costSource})`,
    );
    return { result, record };
  }
}

function decisionLog(
  question: DecisionQuestion,
  result: DecisionResult,
  latencyMs: number,
  call: string,
): DecisionLog {
  const { answer } = result;
  if (question.type === "score" && answer.type === "score") {
    const top = Math.max(1, question.levels.length - 1);
    const level = Math.min(top, Math.max(0, Math.round(answer.score)));
    const levelProbability = answer.probabilities?.[String(level)];
    const confidence = result.confidence ?? levelProbability;
    return {
      question: "score",
      label: question.levels[level] ?? String(level),
      value: Math.min(1, Math.max(0, answer.score / top)),
      raw: answer.score,
      ...(confidence !== undefined && { confidence }),
      ...(result.decisionSource !== undefined && { decisionSource: result.decisionSource }),
      latencyMs,
    };
  }
  if (question.type === "boolean" && answer.type === "boolean") {
    return {
      question: "boolean",
      label: answer.probability >= 0.5 ? "true" : "false",
      value: Math.min(1, Math.max(0, answer.probability)),
      raw: answer.probability,
      ...(result.confidence !== undefined && { confidence: result.confidence }),
      ...(result.decisionSource !== undefined && { decisionSource: result.decisionSource }),
      latencyMs,
    };
  }
  if (question.type === "choice" && answer.type === "choice") {
    if (!Object.hasOwn(question.options, answer.choice))
      throw new ProviderError(`the decision chose "${answer.choice}", which is not an option`);
    // Only a probability the model reported is recorded: none reported is not certainty.
    const p = answer.probabilities?.[answer.choice] ?? result.confidence;
    return {
      question: "choice",
      label: answer.choice,
      ...(p !== undefined && { value: Math.min(1, Math.max(0, p)), raw: p }),
      ...(answer.probabilities !== undefined && { probabilities: answer.probabilities }),
      ...(result.confidence !== undefined && { confidence: result.confidence }),
      ...(result.decisionSource !== undefined && { decisionSource: result.decisionSource }),
      latencyMs,
    };
  }
  throw new ProviderError(
    `the provider answered ${call}'s ${question.type} question with a ${answer.type}: a provider's decide() answers the type each question asks (docs/generation-knobs.md, provider scripts)`,
  );
}
