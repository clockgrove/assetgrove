import { ProviderError } from "../errors.ts";
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

  async generateModel(request: ModelRequest): Promise<ModelResult> {
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
    let body: Json;
    if (multi) {
      const files: Json[] = [];
      for (const name of ["front", "left", "back", "right"]) {
        const image = byView.get(name);
        files.push(image === undefined ? {} : await this.#file(image));
      }
      body = { type: "multiview_to_model", files, ...common };
    } else {
      const image = front ?? request.views[0];
      if (image === undefined) throw new ProviderError("tripo: no reference views given");
      body = { type: "image_to_model", file: await this.#file(image), ...common };
    }
    const { credits, ...result } = await this.#run(body);
    return {
      ...result,
      ...(request.seed !== undefined && { seed: request.seed }),
      ...this.#cost(credits),
    };
  }

  async rigModel(request: RigRequest): Promise<ModelResult> {
    const opts = tripoOptions(request.providerOptions);
    const { credits, ...result } = await this.#run({
      type: "animate_rig",
      original_model_task_id: request.source,
      out_format: "glb",
      rig_type: request.rigType,
      ...(opts["spec"] !== undefined && { spec: opts["spec"] }),
      ...(opts["modelVersion"] !== undefined && { model_version: opts["modelVersion"] }),
    });
    return { ...result, ...this.#cost(credits) };
  }

  async animateModel(request: AnimateRequest): Promise<ModelResult> {
    const { credits, ...result } = await this.#run({
      type: "animate_retarget",
      original_model_task_id: request.source,
      out_format: "glb",
      animations: request.clips,
      bake_animation: true,
      export_with_geometry: true,
    });
    return { ...result, ...this.#cost(credits) };
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

  async #run(body: Json): Promise<ModelResult & { credits?: number }> {
    const type = String(body["type"]);
    const created = await this.#call(type, "POST", "/task", body);
    const taskId = created["task_id"];
    if (typeof taskId !== "string") throw new ProviderError(`tripo ${type}: no task id returned`);

    let waited = 0;
    for (;;) {
      const task = await this.#call(type, "GET", `/task/${encodeURIComponent(taskId)}`);
      const status = task["status"];
      if (status === "success") return this.#finish(type, taskId, task);
      if (status !== "queued" && status !== "running" && status !== "unknown") {
        const code = task["error_code"];
        throw new ProviderError(
          `tripo ${type}: task ${taskId} ${String(status)}${code !== undefined ? ` (error_code ${String(code)})` : ""}`,
        );
      }
      if (waited >= this.#timeoutMs) {
        throw new ProviderError(`tripo ${type}: task ${taskId} timed out after ${waited} ms`);
      }
      await this.#sleep(this.#pollIntervalMs);
      waited += this.#pollIntervalMs;
    }
  }

  async #finish(
    type: string,
    taskId: string,
    task: Json,
  ): Promise<ModelResult & { credits?: number }> {
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

/** Whether Tripo answered a task lookup with an error about that task, not about the account or itself. */
function rejectsTask(error: unknown): boolean {
  if (!(error instanceof ProviderError) || error.providerCode === undefined) return false;
  const status = error.status ?? 0;
  return status < 500 && ![401, 403, 408, 429].includes(status);
}
