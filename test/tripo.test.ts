import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../src/errors.ts";
import type { ProviderSettings } from "../src/settings.ts";
import { TripoProvider } from "../src/gateway/tripo.ts";
import { createProvider } from "../src/providers/adapter.ts";
import { syntheticCharacter } from "./fixtures/glb.ts";

const KEY = "tsk_secret_key_123";
const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

function reply(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status });
}

function fake(options: {
  statuses?: string[];
  output?: Record<string, unknown>;
  credit?: number;
  createReply?: unknown;
  errorCode?: number;
  glb?: Uint8Array;
}) {
  const calls: Call[] = [];
  const statuses = [...(options.statuses ?? ["success"])];
  let uploads = 0;
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body =
      init?.body instanceof FormData
        ? init.body
        : init?.body
          ? JSON.parse(String(init.body))
          : undefined;
    calls.push({ url, method: init?.method ?? "GET", auth: headers.get("authorization"), body });
    if (url.endsWith("/upload/sts"))
      return reply({ code: 0, data: { image_token: `tok${++uploads}` } });
    if (url.endsWith("/user/balance")) return reply({ code: 0, data: { balance: 12.5 } });
    if (url.endsWith("/task")) {
      return reply(options.createReply ?? { code: 0, data: { task_id: "task-1" } });
    }
    if (url.includes("/task/task-1")) {
      const status = statuses.length > 1 ? statuses.shift() : statuses[0];
      return reply({
        code: 0,
        data: {
          task_id: "task-1",
          status,
          consumed_credit: options.credit ?? 30,
          ...(options.errorCode !== undefined && { error_code: options.errorCode }),
          output: options.output ?? { pbr_model: "https://cdn.example/m.glb?sig=1" },
        },
      });
    }
    if (url.startsWith("https://cdn.example/")) return new Response(options.glb ?? GLB);
    return reply({ code: 1, message: "unexpected" }, 404);
  };
  return { calls, fetch: impl as typeof fetch };
}

function provider(
  f: { fetch: typeof fetch },
  sleeps: number[] = [],
  timeoutMs?: number,
  settings: ProviderSettings = {},
) {
  return new TripoProvider({
    apiKey: KEY,
    ...(settings.usdPerCredit !== undefined && { usdPerCredit: settings.usdPerCredit }),
    fetch: f.fetch,
    sleep: async (ms) => void sleeps.push(ms),
    pollIntervalMs: 10,
    ...(timeoutMs !== undefined && { timeoutMs }),
  });
}

const png = (view: string) => ({ view, mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) });

test("multiview orders front, left, back, right with {} for a missing view; the budget is the face limit; credits are priced at the settings' usdPerCredit", async () => {
  const f = fake({});
  const result = await provider(f, [], undefined, { usdPerCredit: 0.01 }).generateModel({
    model: "tripo",
    views: [png("back"), png("front"), png("left")],
    seed: 7,
    maxTriangles: 40000,
    providerOptions: {
      tripo: { modelVersion: "v3", texture: true, pbr: true },
    },
  });
  const create = f.calls.find((c) => c.url.endsWith("/task") && c.method === "POST");
  assert.deepEqual(create?.body, {
    type: "multiview_to_model",
    files: [
      { type: "png", file_token: "tok1" },
      { type: "png", file_token: "tok2" },
      { type: "png", file_token: "tok3" },
      {},
    ],
    model_version: "v3",
    texture: true,
    pbr: true,
    model_seed: 7,
    face_limit: 40000,
  });
  assert.equal(f.calls[0]?.auth, `Bearer ${KEY}`);
  assert.equal(f.calls.filter((c) => c.url.endsWith("/upload/sts")).length, 3);
  const download = f.calls.find((c) => c.url.startsWith("https://cdn.example/"));
  assert.equal(download?.auth, null);
  assert.equal(result.handle, "task-1");
  assert.equal(result.requestId, "task-1");
  assert.equal(result.requestIdSource, "provider");
  assert.equal(result.seed, 7);
  assert.ok(Math.abs((result.costUsd ?? 0) - 0.3) < 1e-9);
  assert.deepEqual(result.glb, GLB);
});

test("a single image falls back to image_to_model; no cost without a rate", async () => {
  const f = fake({});
  const result = await provider(f).generateModel({
    model: "tripo",
    views: [{ ...png("three-quarter"), mediaType: "image/jpeg" }],
  });
  const create = f.calls.find((c) => c.url.endsWith("/task") && c.method === "POST");
  assert.deepEqual(create?.body, {
    type: "image_to_model",
    file: { type: "jpg", file_token: "tok1" },
  });
  assert.equal(result.costUsd, undefined);
  assert.equal("credits" in result, false);
});

test("front alone uses image_to_model", async () => {
  const f = fake({});
  await provider(f).generateModel({ model: "tripo", views: [png("front")] });
  const create = f.calls.find((c) => c.url.endsWith("/task") && c.method === "POST");
  assert.equal((create?.body as { type: string }).type, "image_to_model");
});

test("rig and retarget bodies", async () => {
  const rig = fake({ output: { model: "https://cdn.example/r.glb" } });
  await provider(rig).rigModel({
    model: "tripo",
    source: "task-0",
    rigType: "biped",
    providerOptions: { tripo: { spec: "tripo", modelVersion: "v2.5-20250123" } },
  });
  assert.deepEqual(rig.calls[0]?.body, {
    type: "animate_rig",
    original_model_task_id: "task-0",
    out_format: "glb",
    rig_type: "biped",
    spec: "tripo",
    model_version: "v2.5-20250123",
  });
  const anim = fake({ output: { base_model: "https://cdn.example/a.glb" } });
  await provider(anim).animateModel({
    model: "tripo",
    source: "task-0",
    clips: ["preset:walk", "preset:idle"],
  });
  assert.deepEqual(anim.calls[0]?.body, {
    type: "animate_retarget",
    original_model_task_id: "task-0",
    out_format: "glb",
    animations: ["preset:walk", "preset:idle"],
    bake_animation: true,
    export_with_geometry: true,
  });
});

test("a one-clip retarget with an extra bind take and generic names says which animation is the clip", async () => {
  const glb = syntheticCharacter({
    joints: 3,
    clips: [
      { name: "Armature|Take 001", durationS: 1, loopClosed: true, still: true },
      { name: "Animation_0", durationS: 1, loopClosed: true },
    ],
  });
  const one = await provider(fake({ glb })).animateModel({
    model: "tripo",
    source: "task-0",
    clips: ["preset:quadruped:walk"],
  });
  assert.deepEqual(one.animations, { "preset:quadruped:walk": 1 });
  // Two moving takes, or several clips in one call: the adapter cannot tell, so it says nothing.
  const twoMoving = syntheticCharacter({
    joints: 3,
    clips: [
      { name: "a", durationS: 1, loopClosed: true },
      { name: "b", durationS: 1, loopClosed: false },
    ],
  });
  const unsure = await provider(fake({ glb: twoMoving })).animateModel({
    model: "tripo",
    source: "task-0",
    clips: ["preset:quadruped:walk"],
  });
  assert.equal(unsure.animations, undefined);
  const many = await provider(fake({ glb })).animateModel({
    model: "tripo",
    source: "task-0",
    clips: ["preset:quadruped:walk", "preset:quadruped:run"],
  });
  assert.equal(many.animations, undefined);
});

test("polls queued, running, then success with the injected sleep", async () => {
  const f = fake({ statuses: ["queued", "running", "success"] });
  const sleeps: number[] = [];
  await provider(f, sleeps).rigModel({ model: "tripo", source: "t", rigType: "biped" });
  assert.deepEqual(sleeps, [10, 10]);
  assert.equal(f.calls.filter((c) => c.url.includes("/task/task-1")).length, 3);
});

test("failures become ProviderError without the key", async () => {
  const cases: Array<[ReturnType<typeof fake>, RegExp, number?]> = [
    [fake({ statuses: ["failed"], errorCode: 2002 }), /failed.*2002/],
    [fake({ statuses: ["banned"] }), /banned/],
    [
      fake({ createReply: { code: 1004, message: "invalid animation name: preset:bogus" } }),
      /invalid animation name: preset:bogus \(HTTP \d+, code 1004\)/,
    ],
    [fake({ glb: new Uint8Array([1, 2, 3, 4]) }), /not a binary glTF/],
    [fake({ output: {} }), /no model output/],
    [fake({ statuses: ["running"] }), /timed out/, 25],
  ];
  for (const [f, pattern, timeout] of cases) {
    await assert.rejects(
      provider(f, [], timeout).rigModel({ model: "tripo", source: "t", rigType: "biped" }),
      (error: Error) => {
        assert.ok(error instanceof ProviderError);
        assert.match(error.message, pattern);
        assert.ok(!error.message.includes(KEY));
        return true;
      },
    );
  }
});

test("balance reads the balance", async () => {
  assert.equal(await provider(fake({})).balance(), 12.5);
});

test("without a key a call fails with a provider error naming the key variable", async () => {
  await assert.rejects(new TripoProvider({ apiKey: undefined }).balance(), {
    name: "ProviderError",
    message: /TRIPO_API_KEY is not set/,
  });
});

test("the tripo adapter prices credits with the settings' usdPerCredit in its balance reading", async () => {
  const f = fake({});
  // The adapter's provider fetches through the global fetch it captures when it is made.
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.fetch;
  let tripo: TripoProvider;
  try {
    const configured = createProvider(
      "tripo",
      { keyEnv: "ASSETGROVE_TEST_TRIPO_KEY", usdPerCredit: 0.01 },
      { env: { ASSETGROVE_TEST_TRIPO_KEY: KEY } },
    );
    assert.ok(configured.provider instanceof TripoProvider);
    tripo = configured.provider;
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(await tripo.limitReading(), {
    balance: 12.5,
    unit: "credits",
    balanceUsd: 0.125,
    source: "tripo balance",
  });
  assert.equal(tripo.billing.paid, true);
  assert.deepEqual(tripo.billing.hosts, ["api.tripo3d.ai"]);
});

test("callCost prices a task by its consumed credits at usdPerCredit, and spends nothing", async () => {
  const f = fake({ credit: 30 });
  const cost = await provider(f, [], undefined, { usdPerCredit: 0.01 }).callCost("task-1");
  assert.ok(Math.abs((cost ?? 0) - 0.3) < 1e-9);
  assert.deepEqual(
    f.calls.map((c) => [c.method, new URL(c.url).pathname]),
    [["GET", "/v2/openapi/task/task-1"]],
  );
  const billing = provider(f, [], undefined, { usdPerCredit: 0.01 }).billing;
  assert.equal(billing.reconcile, "per-call-cost");
  assert.ok(billing.callCost);
});

test("callCost is undefined while the task runs, and null without a rate", async () => {
  for (const status of ["queued", "running", "unknown"])
    assert.equal(
      await provider(fake({ statuses: [status] }), [], undefined, { usdPerCredit: 0.01 }).callCost(
        "task-1",
      ),
      undefined,
    );
  assert.equal(await provider(fake({})).callCost("task-1"), null);
  assert.equal(
    await provider(fake({ statuses: ["failed"], credit: 0 }), [], undefined, {
      usdPerCredit: 0.01,
    }).callCost("task-1"),
    0,
  );
});

test("callCost is null for a task ID Tripo rejects, and a transport failure still throws", async () => {
  const f = fake({});
  const tripo = provider(f, [], undefined, { usdPerCredit: 0.01 });
  // The fake answers an unknown task with code 1, HTTP 404.
  assert.equal(await tripo.callCost("task-gone"), null);
  const down = provider(
    {
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    },
    [],
    undefined,
    { usdPerCredit: 0.01 },
  );
  await assert.rejects(down.callCost("task-1"), ProviderError);
  const unauthorised = provider(
    {
      fetch: (async () =>
        new Response(JSON.stringify({ code: 1002, message: "bad key" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    },
    [],
    undefined,
    { usdPerCredit: 0.01 },
  );
  await assert.rejects(unauthorised.callCost("task-1"), ProviderError);
});

test("the tripo adapter keeps callCost through its billing", () => {
  const configured = createProvider(
    "tripo",
    { keyEnv: "ASSETGROVE_TEST_TRIPO_KEY", usdPerCredit: 0.01 },
    { env: { ASSETGROVE_TEST_TRIPO_KEY: KEY } },
  );
  assert.equal(configured.provider.billing.reconcile, "per-call-cost");
  assert.equal(typeof configured.provider.billing.callCost, "function");
});

const modelRequest = { model: "tripo", views: [png("front")] };

test("jobs.model, jobs.rig and jobs.animate each submit one task and return its id as the handle", async () => {
  const requests = [
    ["model", modelRequest, "image_to_model"],
    ["rig", { model: "tripo", source: "task-0", rigType: "biped" }, "animate_rig"],
    ["animate", { model: "tripo", source: "task-0", clips: ["preset:walk"] }, "animate_retarget"],
  ] as const;
  for (const [kind, request, type] of requests) {
    const f = fake({});
    const job = provider(f).jobs[kind] as {
      submit(request: unknown, options: { key: string }): Promise<string>;
    };
    assert.equal(await job.submit(request, { key: "k" }), "task-1");
    const posts = f.calls.filter((c) => c.url.endsWith("/task") && c.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal((posts[0]?.body as { type: string }).type, type);
    assert.equal(
      f.calls.filter((c) => c.url.includes("/task/task-1")).length,
      0,
      "submit does not poll",
    );
  }
});

test("a submit with no task id is a provider error", async () => {
  const f = fake({ createReply: { code: 0, data: {} } });
  await assert.rejects(
    provider(f).jobs.rig!.submit({ model: "tripo", source: "t", rigType: "biped" }, { key: "k" }),
    /no task id returned/,
  );
});

test("job status maps Tripo's states", async () => {
  const expected: Record<string, string> = {
    queued: "queued",
    running: "running",
    success: "done",
    failed: "failed",
    cancelled: "failed",
    banned: "failed",
    expired: "failed",
    unknown: "unknown",
  };
  for (const [tripo, job] of Object.entries(expected))
    for (const kind of ["model", "rig", "animate"] as const)
      assert.equal(await provider(fake({ statuses: [tripo] })).jobs[kind]!.status("task-1"), job);
});

test("job result downloads the glb, prices the credits, and carries the seed", async () => {
  const f = fake({});
  const result = await provider(f, [], undefined, { usdPerCredit: 0.01 }).jobs.model!.result(
    "task-1",
    { ...modelRequest, seed: 9 },
  );
  assert.deepEqual(result.glb, GLB);
  assert.equal(result.handle, "task-1");
  assert.equal(result.requestId, "task-1");
  assert.equal(result.seed, 9);
  assert.ok(Math.abs((result.costUsd ?? 0) - 0.3) < 1e-9);
  const rig = await provider(fake({}), [], undefined, { usdPerCredit: 0.01 }).jobs.rig!.result(
    "task-1",
    { model: "tripo", source: "t", rigType: "biped" },
  );
  assert.deepEqual(rig.glb, GLB);
  assert.equal("seed" in rig, false);
});

test("job result ties a one-clip animate and refuses a task that did not succeed", async () => {
  const glb = syntheticCharacter({
    joints: 3,
    clips: [
      { name: "Armature|Take 001", durationS: 1, loopClosed: true, still: true },
      { name: "Animation_0", durationS: 1, loopClosed: true },
    ],
  });
  const one = await provider(fake({ glb })).jobs.animate!.result("task-1", {
    model: "tripo",
    source: "task-0",
    clips: ["preset:quadruped:walk"],
  });
  assert.deepEqual(one.animations, { "preset:quadruped:walk": 1 });
  await assert.rejects(
    provider(fake({ statuses: ["running"] })).jobs.animate!.result("task-1", {
      model: "tripo",
      source: "task-0",
      clips: ["preset:walk"],
    }),
    ProviderError,
  );
});

test("tripo's jobs declare no idempotency key, lookup or cancel", () => {
  const { jobs } = provider(fake({}));
  for (const kind of ["model", "rig", "animate"] as const) {
    const job = jobs[kind]!;
    assert.equal(job.dedupesByKey, undefined);
    assert.equal(job.find, undefined);
    assert.equal(job.cancel, undefined);
  }
});

test("a direct call stops polling on an unknown task and names it", async () => {
  const sleeps: number[] = [];
  await assert.rejects(
    provider(fake({ statuses: ["running", "unknown"] }), sleeps).rigModel({
      model: "tripo",
      source: "t",
      rigType: "biped",
    }),
    /task task-1 is in an unknown state; a person must check it/,
  );
  assert.deepEqual(sleeps, [10]);
});
