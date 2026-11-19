import { modelDeclarationRecord } from "./model-declarations.ts";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { requireInsideProject } from "./bible.ts";
import { checkCallParameters } from "./call-parameters.ts";
import type { CallParameters, KeyedCallParameters } from "./call-parameters.ts";
import { Budget } from "./budget.ts";
import type { Reservation } from "./budget.ts";
import { ConfirmationError } from "./approvals.ts";
import { InputError, JobStoppedError, ProviderError } from "./errors.ts";
import { BudgetExceededError, EstimateAboveCeilingError } from "./budget.ts";
import { assertLimitDeclared, billingOf } from "./limits.ts";
import type {
  CallKind,
  CallTypes,
  DecisionQuestion,
  DecisionResult,
  EmbedResult,
  GenerationProvider,
  ImageInput,
  ImageOutputParameters,
  JobProvider,
  JobStatus,
  ModelResult,
  ProviderResult,
} from "./gateway/provider.ts";
import { ProviderSet } from "./providers/set.ts";
import { currentRunScope, jobKey } from "./runs/journal.ts";
import type { JobEntry, Journal } from "./runs/journal.ts";
import { RouteUnavailableError } from "./routes.ts";
import type { Route, Routes } from "./routes.ts";
import type { CallRecord, DecisionLog, LoadedReference } from "./types.ts";

/**
 * Budgeted, recorded provider calls. Each call reserves its route's estimate (the ceiling), or the
 * provider's lower `estimate`, against the run's cap (and the budget's cross-run spend ledger,
 * src/spend.ts) before it reaches the provider, then settles as its billing declares (`reported`:
 * the provider's cost; `declared`: what was reserved) and appends a provenance record. A paid call
 * settled above its route's estimate appends a spend hold.
 *
 * Inside a paid command's run (src/runs/execute.ts) each call first checks the run's journal
 * (`calls/<callKey>.json`): a hit reserves nothing, counts its recorded cost against the run's
 * cap and returns the stored result; an answered call is journaled before it is returned.
 *
 * A paid call (its adapter's `billing.paid`) that is not a journal hit needs the run's clearance,
 * which only the executor builds from a verified confirmation; without one it exits 8.
 *
 * A call its provider serves as a queued job (`GenerationProvider.jobs`) is journaled before it is
 * submitted and again with its handle, so a resumed run collects the same job (see `job`).
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
  private readonly polling: Required<JobPolling>;
  private readonly plannedCalls: Map<string, number> | undefined;

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
    /** When given, the confirmed per-operation call counts for this candidate. */
    plannedCalls?: ReadonlyMap<string, number>;
    /** How a queued job is polled; tests shorten it. */
    jobPolling?: JobPolling;
  }) {
    this.provider = options.provider;
    this.providerName = options.providerName;
    this.budget = options.budget;
    this.routes = options.routes;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
    this.index = options.index;
    this.plannedCalls = options.plannedCalls && new Map(options.plannedCalls);
    this.polling = {
      firstMs: 3000,
      maxMs: 30_000,
      deadlineMs: 15 * 60 * 1000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...options.jobPolling,
    };
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

  private async record<K extends CallKind>(
    kind: K,
    operation: string,
    prompt: string,
    references: LoadedReference[],
    parameters: Record<string, unknown>,
    seed: number | undefined,
    request: (route: Route) => CallTypes[K][0],
    direct: (provider: GenerationProvider, request: CallTypes[K][0]) => Promise<CallTypes[K][1]>,
    keyedParameters?: KeyedCallParameters,
  ): Promise<CallTypes[K][1]> {
    type Result = CallTypes[K][1];
    if (this.plannedCalls !== undefined) {
      const remaining = this.plannedCalls.get(operation) ?? 0;
      if (remaining === 0)
        throw new CallRefusedError(
          operation,
          "the candidate's confirmed plan has no call left for this operation",
        );
      this.plannedCalls.set(operation, remaining - 1);
    }
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
      ...(keyedParameters !== undefined && { parameters: keyedParameters }),
    });
    const journaled = callKey === undefined ? undefined : journal?.read(callKey);
    if (journaled !== undefined) {
      // Answered before in this run: nothing is reserved or paid again. A job record a crash left
      // beside the answer has served its purpose.
      journal?.removeJob(callKey!);
      this.budget.addPrior(journaled.record.costUsd, `the journaled ${operation} call`);
      this.records.push(journaled.record);
      scope?.onCall?.({ operation, reused: true });
      return journaled.result as Result;
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
    // The route's estimate is the ceiling: the most one call may cost.
    const ceilingUsd = route.estimatedCostUsd;
    const sent = request(route);
    let estimated: number | undefined;
    // After confirmation and before reserving: the provider's own estimate may only lower it.
    const amount = async (): Promise<number> => {
      const estimate = served.provider.estimate?.bind(served.provider);
      if (estimate === undefined) return ceilingUsd;
      if (estimated === undefined) {
        let value: number;
        try {
          value = await estimate(sent, kind);
        } catch (error) {
          throw providerError(operation, error);
        }
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
          throw new ProviderError(
            `provider "${served.id}" estimated the ${operation} call at ${String(value)}, not a cost in USD`,
          );
        if (value > ceilingUsd + 1e-9)
          throw new EstimateAboveCeilingError(name, operation, value, ceilingUsd);
        estimated = value;
      }
      return Math.min(estimated, ceilingUsd);
    };
    const reserve = async (): Promise<Reservation> => {
      // A run let in past a spend hold only collects the jobs it had submitted.
      if (billing.paid && scope?.spendHold !== undefined) throw scope.spendHold;
      return this.budget.reserve(
        await amount(),
        `the ${operation} call`,
        billing.paid ? name : undefined,
        {
          provider: served.id,
          ...(journal !== undefined && { runId: journal.runId }),
          ...(callKey !== undefined && { callKey }),
          ceilingUsd,
        },
      );
    };
    const jobs = served.provider.jobs?.[kind] as JobProvider<CallTypes[K][0], Result> | undefined;
    const startedAt = this.now().toISOString();
    let result: Result;
    let reservation: Reservation;
    if (jobs !== undefined) {
      ({ result, reservation } = await this.job(jobs, sent, {
        operation,
        provider: served.id,
        reserve,
        ...(callKey !== undefined && { callKey }),
        ...(journal !== undefined && { journal }),
        ...(scope?.spendHold !== undefined && billing.paid && { spendHold: scope.spendHold }),
      }));
    } else {
      reservation = await reserve();
      try {
        result = await direct(served.provider, sent);
      } catch (error) {
        // A failed call may still have been billed; count what was reserved so the cap stays safe.
        this.budget.settle(reservation, reservation.amountUsd);
        throw providerError(operation, error);
      }
    }
    // `reported` settles at the cost in the result, `declared` (or none reported) at the reservation.
    const reported = billing.settle === "reported" ? result.costUsd : undefined;
    const costUsd = reported ?? reservation.amountUsd;
    // The provider's own request ID ties the ledger entry to the provider's usage (reconcile).
    const providerId = result.requestIdSource === "local" ? undefined : result.requestId;
    // A paid call settled above its route's estimate holds every later paid run for a person.
    const hold = this.budget.settle(
      reservation,
      costUsd,
      providerId,
      billing.paid ? { ceilingUsd, provider: served.id, route: name } : undefined,
    );
    if (hold !== undefined)
      this.log(
        `spend hold ${hold.id}: the ${operation} call settled at $${costUsd.toFixed(4)}, above route ${name}'s $${ceilingUsd.toFixed(4)} estimate; paid runs are refused until it is acknowledged`,
      );
    const usedSeed = result.seed ?? seed;
    const record: CallRecord = {
      modelDeclarations: modelDeclarationRecord(route.modelDeclarations),
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
      costSource: reported === undefined ? "estimate" : "provider",
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
      // The answer is journaled: the job's record has served its purpose.
      if (jobs !== undefined) journal.removeJob(callKey);
      scope?.onCall?.({ operation, reused: false });
    }
    return result;
  }

  /**
   * A call served as a queued job (design section 9): reserve, journal the intent (key, ledger
   * reservation, attempt), submit, journal the handle, poll with backoff up to the deadline, and
   * return the result with the reservation for the caller to settle. A resumed run adopts the
   * journaled job and its reservation; a failed job is retried with a new attempt key. Stopping
   * (a kill, the deadline, `unknown`) leaves the job journaled and its reservation open.
   */
  private async job<Request, Result extends ProviderResult>(
    jobs: JobProvider<Request, Result>,
    request: Request,
    call: {
      operation: string;
      provider: string;
      reserve: () => Promise<Reservation>;
      callKey?: string;
      journal?: Journal;
      spendHold?: Error;
    },
  ): Promise<{ result: Result; reservation: Reservation }> {
    const { operation, journal, callKey } = call;
    const journaling = journal !== undefined && callKey !== undefined;
    const runId = journal?.runId ?? `unjournaled-${randomUUID()}`;
    const save = (entry: JobEntry): JobEntry => {
      if (journaling) journal.writeJob(entry);
      return entry;
    };
    const where = journaling ? ` (${join(journal.dir, `${callKey}.job.json`)})` : "";
    // Reserve, journal the intent, submit, journal the handle.
    const submit = async (attempt: number): Promise<[JobEntry, Reservation]> => {
      const reserved = await call.reserve();
      const key = jobKey(runId, callKey ?? operation, attempt);
      const intent = save({
        callKey: callKey ?? "",
        operation,
        provider: call.provider,
        attempt,
        key,
        ...(reserved.ledgerId !== undefined && { reservationId: reserved.ledgerId }),
        reservedUsd: reserved.amountUsd,
      });
      let handle: string;
      try {
        handle = await jobs.submit(request, { key });
      } catch (error) {
        if (refusedSubmit(error)) {
          // The provider answered and refused it: no job was made. It may still bill a refusal,
          // so it keeps what was reserved, and the next attempt has a new key.
          this.budget.settle(reserved, reserved.amountUsd);
          save({ ...intent, failed: true });
          throw providerError(operation, error);
        }
        // Lost on the way (no answer, no task id, a server error): the provider may hold the job.
        // The intent stays journaled with its reservation open, like a crash before the handle.
        throw lostSubmit(key, error);
      }
      return [save({ ...intent, handle, submittedAt: this.now().toISOString() }), reserved];
    };
    const lostSubmit = (key: string, cause?: unknown): JobStoppedError => {
      const detail = cause instanceof Error ? `: ${cause.message}` : "";
      if (jobs.find === undefined && jobs.dedupesByKey !== true)
        return new JobStoppedError(
          `stopped: the ${operation} call's job (key ${key}) may have reached provider "${call.provider}" with no handle journaled${detail}, and the provider can neither find a job by its key nor deduplicate one, so submitting again could pay twice. A person checks the provider's own jobs, then deletes the job record${where} to submit it again`,
          { cause },
        );
      return new JobStoppedError(
        `stopped: the ${operation} call's job (key ${key}) may have reached provider "${call.provider}" with no handle journaled${detail}; it stays journaled with its reservation: repeat the request to find it by its key or submit it again under the same key`,
        { cause },
      );
    };

    let entry = journaling ? journal.readJob(callKey) : undefined;
    let reservation: Reservation;
    if (entry !== undefined && entry.failed !== true) {
      // An earlier attempt of this run reserved and journaled this job: adopt both.
      const { key } = entry;
      if (entry.handle === undefined && jobs.find === undefined && jobs.dedupesByKey !== true)
        throw lostSubmit(key);
      reservation = this.budget.adopt(entry.reservedUsd, entry.reservationId);
      if (entry.handle === undefined) {
        let handle: string | undefined;
        try {
          handle = await jobs.find?.(key);
        } catch (error) {
          throw lostSubmit(key, error);
        }
        if (handle === undefined) {
          if (call.spendHold !== undefined) throw call.spendHold;
          // Never accepted (find names none), or accepted and deduplicated by its key.
          try {
            handle = await jobs.submit(request, { key });
          } catch (error) {
            throw lostSubmit(key, error);
          }
        }
        entry = save({ ...entry, handle, submittedAt: this.now().toISOString() });
      }
    } else {
      [entry, reservation] = await submit((entry?.attempt ?? 0) + 1);
    }
    for (;;) {
      const handle = entry.handle as string;
      const status = await this.poll(jobs, handle, operation, where);
      if (status === "done") {
        try {
          return { result: await jobs.result(handle, request), reservation };
        } catch (error) {
          throw collectStop(operation, handle, where, error);
        }
      }
      // A failed job may still have been billed: it keeps what was reserved.
      this.budget.settle(reservation, reservation.amountUsd);
      entry = save({ ...entry, failed: true });
      if (entry.attempt >= JOB_ATTEMPTS)
        throw new ProviderError(
          `the ${operation} call's job failed ${entry.attempt} times (last ${handle}); repeating the request submits it again`,
        );
      [entry, reservation] = await submit(entry.attempt + 1);
    }
  }

  /**
   * Polls a job until it is done or failed, waiting longer between checks up to the deadline.
   * `unknown` stops for a person and the deadline stops resumable; both leave the job journaled.
   */
  private async poll<Request, Result>(
    jobs: JobProvider<Request, Result>,
    handle: string,
    operation: string,
    where: string,
  ): Promise<"done" | "failed"> {
    const { firstMs, maxMs, deadlineMs, sleep } = this.polling;
    let waited = 0;
    let delay = firstMs;
    for (;;) {
      let status: JobStatus;
      try {
        status = await jobs.status(handle);
      } catch (error) {
        throw collectStop(operation, handle, where, error);
      }
      if (status === "done" || status === "failed") return status;
      if (status === "unknown")
        throw new JobStoppedError(
          `stopped: the provider reports the ${operation} call's job ${handle} in an unknown state. A person checks it with the provider; repeating the request collects it once the provider knows it, and deleting the job record${where} submits it again`,
        );
      if (status !== "queued" && status !== "running")
        throw new ProviderError(
          `the ${operation} call's job ${handle} reported status ${String(status)}`,
        );
      if (waited >= deadlineMs)
        throw new JobStoppedError(
          `the ${operation} call's job ${handle} is still ${status} after ${Math.round(waited / 1000)} s; it stays journaled with its reservation: repeat the request to collect it without paying again`,
        );
      const wait = Math.min(delay, deadlineMs - waited);
      await sleep(wait);
      waited += wait;
      delay = Math.min(maxMs, delay * 1.5);
    }
  }
  /**
   * The typed parameters of an image call, checked before anything is looked up, reserved or sent:
   * each passed one must be mapped by the serving provider's adapter, and the palette must lie
   * inside the project and be readable. Undefined when none is passed.
   */
  private async output(
    operation: string,
    route: Route,
    given: CallParameters | undefined,
  ): Promise<{ keyed: KeyedCallParameters; sent: ImageOutputParameters } | undefined> {
    const passed = checkCallParameters(given, operation);
    if (passed.length === 0 || given === undefined) return undefined;
    const served = this.serve(route, operation);
    let supported: readonly string[] | undefined;
    let adapter: string;
    if (this.provider instanceof ProviderSet) {
      const configured = this.provider.get(served.id);
      supported = configured?.adapter.parameters;
      adapter = configured?.adapter.id ?? "";
    } else {
      supported = served.provider.parameters;
      adapter = served.provider.billing.adapter;
    }
    for (const name of passed)
      if (!(supported ?? []).includes(name))
        throw new RouteUnavailableError(
          operation,
          `route unavailable: the ${operation} call passes ${name}, which provider "${served.id}" (${adapter} adapter) does not map; route ${operation} to a provider whose adapter declares it`,
        );
    const { size, tiling, palette } = given;
    let file: { path: string; sha256: string; bytes: Uint8Array } | undefined;
    if (palette !== undefined) {
      requireInsideProject([palette.path], palette.dir, `the ${operation} call's palette`);
      const full = resolve(palette.dir, palette.path);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(full));
      } catch (error) {
        throw new InputError(`the ${operation} call's palette ${full} cannot be read`, {
          cause: error,
        });
      }
      file = {
        path: palette.path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes,
      };
    }
    return {
      keyed: {
        ...(size !== undefined && { size: { ...size } }),
        ...(tiling !== undefined && { tiling: { ...tiling } }),
        ...(file !== undefined && { palette: { path: file.path, sha256: file.sha256 } }),
      },
      sent: {
        ...(size !== undefined && { size: { ...size } }),
        ...(tiling !== undefined && { tiling: { ...tiling } }),
        ...(file !== undefined && { palette: file }),
      },
    };
  }

  /** An image generation or reference-guided edit; references are sent in order. */
  async image(
    operation: string,
    prompt: string,
    references: LoadedReference[],
    seed?: number,
    options: { mask?: LoadedReference; parameters?: CallParameters } = {},
  ): Promise<ImageInput> {
    const { mask } = options;
    const route = this.route(operation);
    const output = await this.output(operation, route, options.parameters);
    const sendSeed = route.supportsSeed ? seed : undefined;
    const parameters: Record<string, unknown> = {
      ...(route.size !== undefined && { size: route.size }),
      ...(sendSeed !== undefined && { seed: sendSeed }),
      ...(route.providerOptions !== undefined && { providerOptions: route.providerOptions }),
      references: references.map((r) => ({ role: r.role, path: r.path, sha256: r.sha256 })),
      ...(mask !== undefined && { mask: { path: mask.path, sha256: mask.sha256 } }),
      ...(output !== undefined && { callParameters: output.keyed }),
    };
    const result = await this.record(
      "image",
      operation,
      prompt,
      // The mask is hashed with the references, so a different mask is a different call.
      mask === undefined ? references : [...references, mask],
      parameters,
      sendSeed,
      (r) => ({
        model: r.model,
        prompt,
        references: references.map((ref) => ({ mediaType: ref.mediaType, bytes: ref.bytes })),
        ...(mask !== undefined && { mask: { mediaType: mask.mediaType, bytes: mask.bytes } }),
        ...(r.size !== undefined && { size: r.size }),
        ...(sendSeed !== undefined && { seed: sendSeed }),
        ...(r.providerOptions !== undefined && { providerOptions: r.providerOptions }),
        ...(output !== undefined && { output: output.sent }),
      }),
      (provider, request) => provider.generateImage(request),
      output?.keyed,
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
    return this.record(
      "model",
      operation,
      prompt,
      views,
      parameters,
      sendSeed,
      (r) => ({
        model: r.model,
        prompt,
        views: views.map((v) => ({ view: v.view, mediaType: v.mediaType, bytes: v.bytes })),
        ...(sendSeed !== undefined && { seed: sendSeed }),
        ...(maxTriangles !== undefined && { maxTriangles }),
        ...(r.providerOptions !== undefined && { providerOptions: r.providerOptions }),
      }),
      (provider, request) => {
        const generate = provider.generateModel?.bind(provider);
        if (!generate) throw new ProviderError(`the provider cannot make 3D models (${operation})`);
        return generate(request);
      },
    );
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
      (r) => ({
        model: r.model,
        source,
        rigType,
        ...(r.providerOptions !== undefined && { providerOptions: r.providerOptions }),
      }),
      (provider, request) => {
        const rig = provider.rigModel?.bind(provider);
        if (!rig) throw new ProviderError(`the provider cannot rig 3D models (${operation})`);
        return rig(request);
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
      (r) => ({
        model: r.model,
        source,
        clips,
        ...(r.providerOptions !== undefined && { providerOptions: r.providerOptions }),
      }),
      (provider, request) => {
        const animate = provider.animateModel?.bind(provider);
        if (!animate)
          throw new ProviderError(`the provider cannot animate 3D models (${operation})`);
        return animate(request);
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
      (r) => ({
        model: r.model,
        input:
          "image" in input
            ? { image: { mediaType: input.image.mediaType, bytes: input.image.bytes } }
            : { text: input.text },
        dimensions,
        ...(r.providerOptions !== undefined && { providerOptions: r.providerOptions }),
      }),
      (provider, request) => {
        const embed = provider.embed?.bind(provider);
        if (!embed) throw new ProviderError(`the provider cannot embed (${operation})`);
        return embed(request);
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
      (r) => ({
        model: r.model,
        prompt,
        images: images.map((ref) => ({ mediaType: ref.mediaType, bytes: ref.bytes })),
        ...(r.providerOptions !== undefined && { providerOptions: r.providerOptions }),
      }),
      (provider, request) => provider.analyzeImages(request),
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
        (r) => ({
          model: r.model,
          prompt,
          images: images.map((ref) => ({ mediaType: ref.mediaType, bytes: ref.bytes })),
          question,
          operation,
        }),
        (provider, request) => {
          const decide = provider.decide?.bind(provider);
          if (!decide)
            throw new ProviderError(`the provider cannot make typed decisions (${operation})`);
          return decide(request);
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

/** How a queued job is polled: the first wait, the longest, and the deadline per call. */
export interface JobPolling {
  firstMs?: number;
  maxMs?: number;
  deadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** How many times one call's job is submitted in one process before the call fails. */
const JOB_ATTEMPTS = 3;

/**
 * A submit the provider answered and refused (an HTTP 4xx other than a timeout): no job was made.
 * Anything else (no answer, a server error, no task id) may have left a job at the provider.
 */
function refusedSubmit(error: unknown): boolean {
  const status = error instanceof ProviderError ? error.status : undefined;
  return status !== undefined && status >= 400 && status < 500 && status !== 408;
}

/** A submitted job whose status or result could not be read: it stays journaled to collect. */
function collectStop(operation: string, handle: string, where: string, error: unknown): Error {
  if (error instanceof JobStoppedError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new JobStoppedError(
    `stopped: the ${operation} call's job ${handle} could not be collected: ${message}. It stays journaled with its reservation: repeat the request to collect it without paying again, or delete the job record${where} to submit it again`,
    { cause: error },
  );
}

/** A provider failure as `ProviderError`; a budget refusal or a stopped job passes through. */
function providerError(operation: string, error: unknown): Error {
  if (
    error instanceof ConfirmationError ||
    error instanceof ProviderError ||
    error instanceof BudgetExceededError ||
    error instanceof JobStoppedError
  )
    return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(`the ${operation} call failed: ${message}`, { cause: error });
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

/** A provider call refused before any reservation or request: exit 2 `invalid_input`. */
export class CallRefusedError extends InputError {
  readonly operation: string;
  constructor(operation: string, why: string) {
    super(`the ${operation} call was refused: ${why}`);
    this.name = "CallRefusedError";
    this.operation = operation;
  }
}

/**
 * A `Caller` that refuses every call before it reserves anything or reaches a provider, and keeps
 * the operation of each one asked (`attempts`), so a check that catches the refusal is still seen.
 * Core runs a kind's `exact` QA checks under one (src/loop.ts); so does the conformance suite.
 */
export class RefusingCaller extends Caller {
  readonly attempts: string[] = [];
  private readonly why: string;

  constructor(why = "an exact check makes no provider call") {
    super({ provider: {} as GenerationProvider, budget: new Budget(0), routes: {} as Routes });
    this.why = why;
  }

  override route(operation: string): Route {
    this.attempts.push(operation);
    throw new CallRefusedError(operation, this.why);
  }
}
