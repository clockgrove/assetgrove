import { ProviderError } from "../errors.ts";
import { parseGlb } from "../model3d/glb.ts";
import { movingAnimations } from "../model3d/scene.ts";
import { isQuotaRefusal, ProviderQuotaError } from "./failure.ts";
import type {
  AnimateRequest,
  GenerationProvider,
  ImageResult,
  VisionResult,
  Billing,
  LimitReading,
  ImageInput,
  ModelRequest,
  ModelResult,
  RigRequest,
  JobStatus,
  ProviderJobs,
} from "./provider.ts";

/** Tripo's fixed endpoint; settings never move it. */
export const TRIPO_BASE_URL = "https://api.tripo3d.ai/v2/openapi";
const FILE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
};

type Json = Record<string, unknown>;
type Options = Record<string, unknown>;

function tripoOptions(providerOptions: Record<string, Options> | undefined): Options {
  return providerOptions?.["tripo"] ?? {};
}

function fileType(mediaType: string): string {
  const type = FILE_TYPES[mediaType.toLowerCase()];
  if (type === undefined) throw new ProviderError(`tripo: unsupported image type ${mediaType}`);
  return type;
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The Tripo image-to-3D adapter: model generation, rigging and animation retargeting. A call's
 * cost is the task's reported credits × `usdPerCredit` from settings; without a rate it is unset
 * and the route's estimate stands.
 */
export class TripoProvider implements GenerationProvider {
  readonly billing: Billing;
  readonly #apiKey: string | undefined;
  readonly #keyEnv: string;
  readonly #usdPerCredit: number | undefined;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #pollIntervalMs: number;
  readonly #timeoutMs: number;

  constructor(options: {
    apiKey: string | undefined;
    keyEnv?: string;
    /** USD per Tripo credit, from settings (`providers.<id>.usdPerCredit`). */
    usdPerCredit?: number;
    billing?: Omit<Billing, "hosts" | "readLimit" | "callCost">;
    /** Tests only: a loopback fixture. Settings never set it. */
    baseUrl?: string;
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    pollIntervalMs?: number;
    timeoutMs?: number;
  }) {
    this.#apiKey = options.apiKey || undefined;
    this.#keyEnv = options.keyEnv ?? "TRIPO_API_KEY";
    this.#usdPerCredit = options.usdPerCredit;
    this.#baseUrl = (options.baseUrl ?? TRIPO_BASE_URL).replace(/\/+$/, "");
    this.billing = {
      adapter: "tripo",
      providerId: "tripo",
      paid: true,
      reconcile: "per-call-cost",
      ...options.billing,
      hosts: [new URL(this.#baseUrl).host],
      readLimit: () => this.limitReading(),
      callCost: (taskId) => this.callCost(taskId),
    };
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.#timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
  }

  generateImage(): Promise<ImageResult> {
    return Promise.reject(new ProviderError("tripo cannot generate images"));
  }

  analyzeImages(): Promise<VisionResult> {
    return Promise.reject(new ProviderError("tripo cannot analyze images"));
  }

  /** The account's credit balance; spends nothing. */
  async balance(): Promise<number> {
    const data = await this.#call("balance", "GET", "/user/balance");
    const balance = data["balance"];
    if (typeof balance !== "number") throw new ProviderError("tripo balance: no balance returned");
    return balance;
  }

  /** The balance as a limit reading: credits, and USD when settings give `usdPerCredit`. */
  async limitReading(): Promise<LimitReading> {
    const balance = await this.balance();
    return {
      balance,
      unit: "credits",
      ...(this.#usdPerCredit !== undefined && { balanceUsd: balance * this.#usdPerCredit }),
      source: "tripo balance",
    };
  }

  /**
   * One task's cost in USD by its task ID (the journaled request ID); spends nothing. Undefined
   * while the task is queued or running or reports no credits yet; null when no `usdPerCredit`
   * prices it, a task that ended without a credit count, or a task ID Tripo rejects (it answered
   * with an error code other than an auth, rate or server failure). A transport failure, or an
   * auth, rate or server refusal, is thrown: it says nothing about this one task.
   */
  async callCost(taskId: string): Promise<number | null | undefined> {
    let task: Json;
    try {
      task = await this.#call("task", "GET", `/task/${encodeURIComponent(taskId)}`);
    } catch (error) {
      if (rejectsTask(error)) return null;
      throw error;
    }
    const status = task["status"];
    const credits = task["consumed_credit"];
    if (status === "queued" || status === "running" || status === "unknown") return undefined;
    if (typeof credits !== "number") return status === "success" ? undefined : null;
    return this.#usdPerCredit === undefined ? null : credits * this.#usdPerCredit;
  }

  /**
   * Tripo's calls as jobs: submit a task, read its status, fetch its result. Tripo takes no
   * idempotency key and cannot look a task up by one, and a task cannot be cancelled, so none of
   * those are declared.
   */
  readonly jobs: ProviderJobs = {
    model: {
      // The key is unused: Tripo has nowhere to put it.
      submit: async (request) => this.#create(await this.#modelBody(request)),
      status: (handle) => this.#status(handle),
      result: async (handle, request) =>
        this.#modelResult(await this.#successful("model", handle), request),
    },
    rig: {
      submit: (request) => this.#create(this.#rigBody(request)),
      status: (handle) => this.#status(handle),
      result: async (handle) => this.#rigResult(await this.#successful("rig", handle)),
    },
    animate: {
      submit: (request) => this.#create(this.#animateBody(request)),
      status: (handle) => this.#status(handle),
      result: async (handle, request) =>
        this.#animateResult(await this.#successful("animate", handle), request),
    },
  };

  async generateModel(request: ModelRequest): Promise<ModelResult> {
    const task = await this.#await(await this.#create(await this.#modelBody(request)), "model");
    return this.#modelResult(task, request);
  }

  async rigModel(request: RigRequest): Promise<ModelResult> {
    const task = await this.#await(await this.#create(this.#rigBody(request)), "rig");
    return this.#rigResult(task);
  }

  async animateModel(request: AnimateRequest): Promise<ModelResult> {
    const task = await this.#await(await this.#create(this.#animateBody(request)), "animate");
    return this.#animateResult(task, request);
  }

  async #modelBody(request: ModelRequest): Promise<Json> {
    const opts = tripoOptions(request.providerOptions);
    const byView = new Map<string, ImageInput>();
    for (const v of request.views) if (!byView.has(v.view)) byView.set(v.view, v);
    const front = byView.get("front");
    const multi = front !== undefined && ["left", "back", "right"].some((v) => byView.has(v));
    const common: Json = {
      ...(opts["modelVersion"] !== undefined && { model_version: opts["modelVersion"] }),
      ...(opts["texture"] !== undefined && { texture: opts["texture"] }),
      ...(opts["pbr"] !== undefined && { pbr: opts["pbr"] }),
      ...(request.seed !== undefined && { model_seed: request.seed }),
      // Tripo's faces are triangles unless `quad` is set; without a limit it returns ~400K.
      ...(request.maxTriangles !== undefined && { face_limit: request.maxTriangles }),
    };
    if (multi) {
      const files: Json[] = [];
      for (const name of ["front", "left", "back", "right"]) {
        const image = byView.get(name);
        files.push(image === undefined ? {} : await this.#file(image));
      }
      return { type: "multiview_to_model", files, ...common };
    }
    const image = front ?? request.views[0];
    if (image === undefined) throw new ProviderError("tripo: no reference views given");
    return { type: "image_to_model", file: await this.#file(image), ...common };
  }

  #rigBody(request: RigRequest): Json {
    const opts = tripoOptions(request.providerOptions);
    return {
      type: "animate_rig",
      original_model_task_id: request.source,
      out_format: "glb",
      rig_type: request.rigType,
      ...(opts["spec"] !== undefined && { spec: opts["spec"] }),
      ...(opts["modelVersion"] !== undefined && { model_version: opts["modelVersion"] }),
    };
  }

  #animateBody(request: AnimateRequest): Json {
    return {
      type: "animate_retarget",
      original_model_task_id: request.source,
      out_format: "glb",
      animations: request.clips,
      bake_animation: true,
      export_with_geometry: true,
    };
  }

  async #modelResult(task: Json, request: ModelRequest): Promise<ModelResult> {
    const { credits, ...result } = await this.#finish("model", task);
    return {
      ...result,
      ...(request.seed !== undefined && { seed: request.seed }),
      ...this.#cost(credits),
    };
  }

  async #rigResult(task: Json): Promise<ModelResult> {
    const { credits, ...result } = await this.#finish("rig", task);
    return { ...result, ...this.#cost(credits) };
  }

  async #animateResult(task: Json, request: AnimateRequest): Promise<ModelResult> {
    const { credits, ...result } = await this.#finish("animate", task);
    const tied = request.clips.length === 1 ? tieClip(request.clips[0]!, result.glb) : undefined;
    return { ...result, ...(tied && { animations: tied }), ...this.#cost(credits) };
  }

  #cost(credits: number | undefined): { costUsd?: number } {
    const rate = this.#usdPerCredit;
    return credits !== undefined && rate !== undefined ? { costUsd: credits * rate } : {};
  }

  async #file(image: ImageInput): Promise<Json> {
    const type = fileType(image.mediaType);
    const form = new FormData();
    form.append(
      "file",
      new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.mediaType }),
      `view.${type}`,
    );
    const data = await this.#call("upload", "POST", "/upload/sts", form);
    const token = data["image_token"];
    if (typeof token !== "string") throw new ProviderError("tripo upload: no image token returned");
    return { type, file_token: token };
  }

  async #call(label: string, method: string, path: string, body?: FormData | Json): Promise<Json> {
    if (this.#apiKey === undefined)
      throw new ProviderError(`tripo ${label}: ${this.#keyEnv} is not set`);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#apiKey}` };
    let payload: FormData | string | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        ...(payload !== undefined && { body: payload }),
      });
    } catch (error) {
      throw new ProviderError(`tripo ${label}: request failed`, { cause: error });
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ProviderError(`tripo ${label}: HTTP ${response.status} with no JSON body`);
    }
    if (!isRecord(json))
      throw new ProviderError(`tripo ${label}: unexpected response (HTTP ${response.status})`);
    const code = json["code"];
    if (code !== 0) {
      // Only the provider's message, the status and its code; never the rest of the body.
      const message = typeof json["message"] === "string" ? json["message"] : "request failed";
      const text = `tripo ${label}: ${message} (HTTP ${response.status}, code ${String(code)})`;
      if (isQuotaRefusal({ message, status: response.status }))
        throw new ProviderQuotaError(`refused: ${text}`, response.status, String(code));
      throw new ProviderError(text, { status: response.status, providerCode: String(code) });
    }
    return isRecord(json["data"]) ? json["data"] : {};
  }

  /** Creates a task and returns its ID. */
  async #create(body: Json): Promise<string> {
    const type = String(body["type"]);
    const created = await this.#call(type, "POST", "/task", body);
    const taskId = created["task_id"];
    if (typeof taskId !== "string") throw new ProviderError(`tripo ${type}: no task id returned`);
    return taskId;
  }

  #readTask(taskId: string): Promise<Json> {
    return this.#call("task", "GET", `/task/${encodeURIComponent(taskId)}`);
  }

  async #status(taskId: string): Promise<JobStatus> {
    return jobStatus((await this.#readTask(taskId))["status"]);
  }

  /** The task, read once, when it succeeded; any other state is an error. */
  async #successful(label: string, taskId: string): Promise<Json> {
    const task = await this.#readTask(taskId);
    if (task["status"] !== "success")
      throw new ProviderError(
        `tripo ${label}: task ${taskId} is ${String(task["status"])}, not success`,
      );
    return { ...task, task_id: taskId };
  }

  /** Polls a task until it succeeds, for direct callers; the job path polls through the core. */
  async #await(taskId: string, label: string): Promise<Json> {
    let waited = 0;
    for (;;) {
      const task = await this.#readTask(taskId);
      const status = jobStatus(task["status"]);
      if (status === "done") return { ...task, task_id: taskId };
      if (status === "failed") {
        const code = task["error_code"];
        throw new ProviderError(
          `tripo ${label}: task ${taskId} ${String(task["status"])}${code !== undefined ? ` (error_code ${String(code)})` : ""}`,
        );
      }
      if (status === "unknown")
        throw new ProviderError(
          `tripo ${label}: task ${taskId} is in an unknown state; a person must check it`,
        );
      if (waited >= this.#timeoutMs) {
        throw new ProviderError(`tripo ${label}: task ${taskId} timed out after ${waited} ms`);
      }
      await this.#sleep(this.#pollIntervalMs);
      waited += this.#pollIntervalMs;
    }
  }

  async #finish(type: string, task: Json): Promise<ModelResult & { credits?: number }> {
    const taskId = String(task["task_id"]);
    const output = isRecord(task["output"]) ? task["output"] : {};
    const url = ["model", "pbr_model", "base_model"]
      .map((k) => output[k])
      .find((v): v is string => typeof v === "string" && v !== "");
    if (url === undefined)
      throw new ProviderError(`tripo ${type}: task ${taskId} has no model output`);
    let response: Response;
    try {
      response = await this.#fetch(url);
    } catch (error) {
      throw new ProviderError(`tripo ${type}: model download failed`, { cause: error });
    }
    if (!response.ok) {
      throw new ProviderError(`tripo ${type}: model download failed (HTTP ${response.status})`);
    }
    const glb = new Uint8Array(await response.arrayBuffer());
    if (new TextDecoder().decode(glb.subarray(0, 4)) !== "glTF") {
      throw new ProviderError(`tripo ${type}: downloaded model is not a binary glTF`);
    }
    const credits = task["consumed_credit"];
    return {
      handle: taskId,
      glb,
      requestId: taskId,
      requestIdSource: "provider",
      ...(typeof credits === "number" && { credits }),
    };
  }
}

/** Tripo's task status as a job status: anything but queued, running, success or unknown ended badly. */
function jobStatus(status: unknown): JobStatus {
  if (status === "queued" || status === "running") return status;
  if (status === "success") return "done";
  if (status === "unknown") return "unknown";
  return "failed";
}

/**
 * Which animation of a one-clip retarget is the clip: the one animation that moves. A bind or
 * T-pose take Tripo adds holds still, and names are never read. Undefined when the model does not
 * parse or not exactly one animation moves; the caller then names the clip unmatched.
 */
function tieClip(clip: string, glb: Uint8Array): Record<string, number> | undefined {
  let moving: number[];
  try {
    moving = movingAnimations(parseGlb(glb));
  } catch {
    return undefined;
  }
  return moving.length === 1 ? { [clip]: moving[0]! } : undefined;
}

/** Whether Tripo answered a task lookup with an error about that task, not about the account or itself. */
function rejectsTask(error: unknown): boolean {
  if (!(error instanceof ProviderError) || error.providerCode === undefined) return false;
  const status = error.status ?? 0;
  return status < 500 && ![401, 403, 408, 429].includes(status);
}
