import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import wavefile from "wavefile";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { JobStoppedError, ProviderError } from "../src/errors.ts";
import { ProviderQuotaError } from "../src/gateway/failure.ts";
import { STABILITY_BASE_URL, StabilityProvider } from "../src/gateway/stability.ts";
import type { Routes } from "../src/routes.ts";
import { Journal, withRunScope } from "../src/runs/journal.ts";
import type { Clearance } from "../src/runs/journal.ts";
import { SpendLedger } from "../src/spend.ts";

const KEY = "sk-stability-secret-123";
const BASE = "https://stability.test";

function makeWav(): Uint8Array {
  const wav = new wavefile.WaveFile();
  wav.fromScratch(1, 8000, "16", [0, 1000, -1000, 500]);
  return wav.toBuffer();
}
const WAV = makeWav();

interface Call {
  url: string;
  method: string;
  auth: string | null;
  accept: string | null;
  form: FormData | undefined;
}

type Answer = Response | (() => Response);

/** A fake `fetch` answering each "METHOD path" from a script, in turn (the last answer repeats). */
function fake(script: Record<string, Answer[]>) {
  const calls: Call[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method,
      auth: headers.get("authorization"),
      accept: headers.get("accept"),
      form: init?.body instanceof FormData ? init.body : undefined,
    });
    const queue = script[`${method} ${url.slice(BASE.length)}`];
    if (queue === undefined) return Promise.reject(new Error(`unscripted ${method} ${url}`));
    const answer = queue.length > 1 ? queue.shift()! : queue[0]!;
    return Promise.resolve(typeof answer === "function" ? answer() : answer.clone());
  };
  return { calls, impl: impl as typeof fetch };
}

const wavReply = (headers: Record<string, string> = {}) =>
  new Response(WAV as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { "content-type": "audio/wav", ...headers },
  });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const V25 = "POST /v2beta/audio/stable-audio-2/text-to-audio";
const V3 = "POST /v2beta/audio/stable-audio-3/text-to-audio";

function provider(impl: typeof fetch, extra: { usdPerCredit?: number; apiKey?: string } = {}) {
  return new StabilityProvider({
    apiKey: KEY,
    baseUrl: BASE,
    fetch: impl,
    sleep: () => Promise.resolve(),
    pollIntervalMs: 1000,
    timeoutMs: 5000,
    ...extra,
  });
}

test("2.5 sends the WAV form and returns WAV bytes at 8 credits", async () => {
  const f = fake({ [V25]: [wavReply({ seed: "42", "x-request-id": "req-1" })] });
  const result = await provider(f.impl).generateAudio({
    model: "stable-audio-2.5",
    prompt: "a door creak",
    durationS: 3,
    seed: 7,
  });
  assert.equal(f.calls.length, 1);
  const [call] = f.calls;
  assert.equal(call!.url, `${BASE}/v2beta/audio/stable-audio-2/text-to-audio`);
  assert.equal(call!.auth, `Bearer ${KEY}`);
  assert.equal(call!.accept, "audio/*");
  assert.deepEqual(Object.fromEntries(call!.form!.entries()), {
    prompt: "a door creak",
    model: "stable-audio-2.5",
    output_format: "wav",
    duration: "3",
    seed: "7",
  });
  assert.deepEqual(result.audio.bytes, WAV);
  assert.equal(result.audio.mediaType, "audio/wav");
  assert.equal(result.costUsd, 0.08);
  assert.equal(result.seed, 42);
  assert.equal(result.requestId, "req-1");
  assert.equal(result.requestIdSource, "provider");
});

test("2.5 omits duration and seed when not given, and makes a local request id without a header", async () => {
  const f = fake({ [V25]: [wavReply()] });
  const result = await provider(f.impl).generateAudio({ model: "stable-audio-2.5", prompt: "x" });
  assert.deepEqual([...f.calls[0]!.form!.keys()].sort(), ["model", "output_format", "prompt"]);
  assert.equal(result.requestIdSource, "local");
  assert.ok(result.requestId.length > 0);
  assert.equal(result.seed, undefined);
});

test("the cost is 8 x usdPerCredit when settings give a rate", async () => {
  const f = fake({ [V25]: [wavReply()] });
  const p = provider(f.impl, { usdPerCredit: 0.02 });
  assert.equal(p.estimate({ model: "stable-audio-2.5", prompt: "x" }, "audio"), 0.16);
  const result = await p.generateAudio({ model: "stable-audio-2.5", prompt: "x" });
  assert.equal(result.costUsd, 0.16);
});

test("estimate is 8 x the rate and refuses an out-of-range duration or unknown model", () => {
  const p = provider(fake({}).impl);
  assert.equal(
    p.estimate({ model: "stable-audio-2.5", prompt: "x", durationS: 190 }, "audio"),
    0.08,
  );
  assert.equal(
    p.estimate({ model: "stable-audio-3.0", prompt: "x", durationS: 380 }, "audio"),
    0.08,
  );
  assert.throws(
    () => p.estimate({ model: "stable-audio-2.5", prompt: "x", durationS: 191 }, "audio"),
    ProviderError,
  );
  assert.throws(
    () => p.estimate({ model: "stable-audio-3.0", prompt: "x", durationS: 0.5 }, "audio"),
    ProviderError,
  );
  assert.throws(
    () => p.estimate({ model: "stable-audio-1", prompt: "x" }, "audio"),
    /stable-audio-2\.5 or stable-audio-3\.0/,
  );
});

test("a missing key refuses each call, naming the variable, without a request", async () => {
  const f = fake({});
  const p = new StabilityProvider({ apiKey: undefined, baseUrl: BASE, fetch: f.impl });
  await assert.rejects(
    p.generateAudio({ model: "stable-audio-2.5", prompt: "x" }),
    /STABILITY_API_KEY is not set/,
  );
  await assert.rejects(p.limitReading(), /STABILITY_API_KEY/);
  assert.equal(f.calls.length, 0);
});

test("an error body becomes a ProviderError with status and code, echoing only errors", async () => {
  const f = fake({
    [V25]: [
      json(
        { name: "invalid_parameters", errors: ["duration is too long"], secret: "do-not-echo" },
        400,
      ),
    ],
  });
  await assert.rejects(
    provider(f.impl).generateAudio({ model: "stable-audio-2.5", prompt: "x" }),
    (error: Error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.status, 400);
      assert.equal(error.providerCode, "invalid_parameters");
      assert.match(error.message, /duration is too long/);
      assert.ok(!error.message.includes("do-not-echo"));
      assert.ok(!error.message.includes(KEY));
      return true;
    },
  );
});

test("402 and rate limits are quota refusals", async () => {
  for (const status of [402, 429]) {
    const f = fake({ [V25]: [json({ name: "payment_required", errors: ["no credits"] }, status)] });
    await assert.rejects(
      provider(f.impl).generateAudio({ model: "stable-audio-2.5", prompt: "x" }),
      ProviderQuotaError,
    );
  }
});

test("a CONTENT_FILTERED result is refused", async () => {
  const f = fake({ [V25]: [wavReply({ "finish-reason": "CONTENT_FILTERED" })] });
  await assert.rejects(
    provider(f.impl).generateAudio({ model: "stable-audio-2.5", prompt: "x" }),
    /CONTENT_FILTERED/,
  );
});

test("3.0 called directly submits, polls 202 then 200, and returns the audio", async () => {
  const f = fake({
    [V3]: [json({ id: "job-9" })],
    "GET /v2beta/results/job-9": [new Response(null, { status: 202 }), wavReply()],
  });
  const result = await provider(f.impl).generateAudio({
    model: "stable-audio-3.0",
    prompt: "wind",
    durationS: 300,
  });
  assert.equal(f.calls[0]!.accept, "application/json");
  assert.equal(f.calls[0]!.form!.get("model"), "stable-audio-3.0");
  const polls = f.calls.filter((c) => c.method === "GET");
  assert.equal(polls.length, 2, "the collected result is not downloaded again");
  assert.equal(polls[0]!.accept, "audio/*");
  assert.equal(result.requestId, "job-9");
  assert.equal(result.costUsd, 0.08);
  assert.deepEqual(result.audio.bytes, WAV);
});

test("3.0 called directly gives up at the timeout", async () => {
  const f = fake({
    [V3]: [json({ id: "job-9" })],
    "GET /v2beta/results/job-9": [new Response(null, { status: 202 })],
  });
  await assert.rejects(
    provider(f.impl).generateAudio({ model: "stable-audio-3.0", prompt: "wind" }),
    /timed out/,
  );
});

test("jobs.audio serves only 3.0, declares no key dedupe or find, and maps statuses; a 429 or 5xx poll throws", async () => {
  const f = fake({
    "GET /v2beta/results/a": [new Response(null, { status: 202 })],
    "GET /v2beta/results/b": [wavReply()],
    "GET /v2beta/results/c": [json({ name: "not_found", errors: ["gone"] }, 404)],
    "GET /v2beta/results/d": [json({ name: "server_error", errors: ["boom"] }, 500)],
    "GET /v2beta/results/e": [json({ name: "rate_limited", errors: ["slow down"] }, 429)],
  });
  const jobs = provider(f.impl).jobs!.audio!;
  assert.equal(jobs.serves!({ model: "stable-audio-3.0", prompt: "x" }), true);
  assert.equal(jobs.serves!({ model: "stable-audio-2.5", prompt: "x" }), false);
  assert.equal(jobs.dedupesByKey, undefined);
  assert.equal(jobs.find, undefined);
  assert.equal(await jobs.status("a"), "running");
  assert.equal(await jobs.status("b"), "done");
  assert.equal(await jobs.status("c"), "unknown");
  // A server error or a rate limit says nothing about the job itself: thrown, never "failed".
  await assert.rejects(jobs.status("d"), /boom \(HTTP 500, server_error\)/);
  await assert.rejects(jobs.status("e"), /slow down \(HTTP 429, rate_limited\)/);
  const result = await jobs.result("b", { model: "stable-audio-3.0", prompt: "x" });
  assert.deepEqual(result.audio.bytes, WAV);
  assert.equal(f.calls.filter((c) => c.url.endsWith("/results/b")).length, 1);
});

test("the balance reads credits and prices them", async () => {
  const f = fake({ "GET /v1/user/balance": [json({ credits: 250 })] });
  const p = provider(f.impl);
  assert.deepEqual(await p.billing.readLimit!(), {
    balance: 250,
    unit: "credits",
    balanceUsd: 2.5,
    source: "stability balance",
  });
  assert.equal(f.calls[0]!.auth, `Bearer ${KEY}`);
  assert.deepEqual(p.billing.hosts, ["stability.test"]);
  assert.equal(p.billing.reconcile, "unavailable");
  assert.equal(p.billing.settle, "reported");
});

test("images are refused and the default base URL is Stability's", async () => {
  assert.equal(STABILITY_BASE_URL, "https://api.stability.ai");
  await assert.rejects(provider(fake({}).impl).generateImage(), /serves audio only/);
  assert.deepEqual(provider(fake({}).impl).audioParameters, ["durationS", "seed"]);
});

const temporary: string[] = [];
after(async () => {
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("through core: a resumed run collects the journaled 3.0 job with no second submit", async () => {
  const runId = "r-00000000000000ab";
  const root = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-stability-")));
  temporary.push(root);
  const dir = join(root, runId);
  mkdirSync(dir);
  const f = fake({
    [V3]: [json({ id: "job-77" })],
    "GET /v2beta/results/job-77": [new Response(null, { status: 202 }), wavReply()],
  });
  const stability = new StabilityProvider({
    apiKey: KEY,
    baseUrl: BASE,
    fetch: f.impl,
    billing: {
      adapter: "stability",
      providerId: "stability",
      paid: true,
      settle: "reported",
      reconcile: "unavailable",
      limit: { kind: "prepaid", usd: 100 },
    },
  });
  const routes = {
    audio: { provider: "stability", model: "stable-audio-3.0", estimatedCostUsd: 0.08 },
  } as unknown as Routes;
  const clearance = { digest: "d", record: {} } as unknown as Clearance;
  const run = (deadlineMs: number) =>
    withRunScope({ journal: new Journal(dir, runId), clearance }, () => {
      const ledger = new SpendLedger({
        path: join(root, "spend.jsonl"),
        caps: { runUsd: 10, dailyUsd: 100, workItemUsd: 100 },
        daily: { settings: 100 },
        workItemLimit: { settings: 100 },
      });
      const caller = new Caller({
        provider: stability,
        providerName: "stability",
        budget: new Budget(5, ledger),
        routes,
        jobPolling: { firstMs: 1, maxMs: 1, deadlineMs, sleep: () => Promise.resolve() },
      });
      return caller.audio("audio", "a door creak", { parameters: { durationS: 4 } });
    });
  const posts = () => f.calls.filter((c) => c.method === "POST").length;

  await assert.rejects(run(0), JobStoppedError);
  assert.equal(posts(), 1);
  assert.equal(new Journal(dir, runId).openJobs()[0]?.handle, "job-77");

  const audio = await run(60_000);
  assert.deepEqual(audio.bytes, WAV);
  assert.equal(posts(), 1, "the resumed run did not submit again");
});
