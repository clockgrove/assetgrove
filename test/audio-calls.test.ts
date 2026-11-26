/**
 * The audio call kind through core (#520): `Caller.audio`'s closed parameter set, the prompt
 * policy, the WAV intake check, the terms, grant and declared training opt-out on each call
 * record, the refused audio routes, the account check at plan and at `doctor`, and the two audio
 * adapters as core makes them from settings, over scripted HTTP. No key, no network.
 */
import "./fixtures/env.ts";
import { settingsPath, stateDir } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { doctorCommand } from "../src/commands/doctor.ts";
import type { RunContext } from "../src/commands/types.ts";
import { InputError, ProviderError } from "../src/errors.ts";
import { PromptRefusedError } from "../src/policy/text.ts";
import { packageBlocklist } from "../src/policy/blocklist.ts";
import { CORE_ADAPTERS } from "../src/providers/adapter.ts";
import { ProviderSet } from "../src/providers/set.ts";
import { buildWorkPlan, checkAccounts, jobsOf } from "../src/runs/plan.ts";
import { CORE_ENTRY, ExtensionRegistry } from "../src/extensions/registry.ts";
import type { Extension } from "../src/extension/api.ts";
import { EXIT } from "../src/errors.ts";
import { grantOf } from "../src/license.ts";
import { Journal, withRunScope } from "../src/runs/journal.ts";
import type { Clearance } from "../src/runs/journal.ts";
import { resolveRoute, RouteUnavailableError } from "../src/routes.ts";
import type { RouteProvider } from "../src/routes.ts";
import { toneWav } from "./fixtures/wav.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";

const WAV = toneWav({ length: 64 });
const LIMIT = { kind: "prepaid", usd: 100 };

/** A scripted provider set: the scripted stand-in serves core's `audio` route (Stable Audio 2.5). */
function scripted(
  audio: (request: Record<string, unknown>) => Record<string, unknown>,
  settings: Record<string, unknown> = {},
  promptAllow: string[] = [],
) {
  const calls: Record<string, unknown>[] = [];
  const script = {
    image: () => {
      throw new Error("no image call expected");
    },
    vision: () => {
      throw new Error("no vision call expected");
    },
    audio: (request: Record<string, unknown>) => {
      calls.push(request);
      return audio(request);
    },
  };
  const provider = ProviderSet.fromSettings(
    {
      providers: { scripted: { limit: LIMIT } },
      roles: {},
      routes: {},
      path: "settings.json",
      ...settings,
    } as never,
    { script: script as never, promptAllow },
  );
  const caller = new Caller({ provider, budget: new Budget(5), routes: provider.routes });
  return { caller, calls };
}

const wav = () => ({ audio: { mediaType: "audio/wav", bytes: WAV } });

test("call.audio takes only durationS, seed and promptInfluence, and refuses any other key by name", async () => {
  const { caller, calls } = scripted(wav);
  for (const key of ["loop", "size", "outputFormat"]) {
    await assert.rejects(
      () => caller.audio("audio", "a door creak", { parameters: { [key]: 1 } as never }),
      (error: unknown) => {
        assert.ok(error instanceof InputError);
        assert.match(error.message, new RegExp(`name "${key}", which is not an audio parameter`));
        assert.match(error.message, /durationS, seed, promptInfluence/);
        return true;
      },
    );
  }
  await assert.rejects(
    () => caller.audio("audio", "a door creak", { parameters: { promptInfluence: 2 } }),
    /promptInfluence must be a number from 0 to 1/,
  );
  assert.equal(calls.length, 0);
  assert.equal(caller.records.length, 0);

  const audio = await caller.audio("audio", "a door creak", {
    parameters: { durationS: 3, seed: 7, promptInfluence: 0.4 },
  });
  assert.deepEqual(audio.bytes, WAV);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    { ...calls[0] },
    {
      model: "stable-audio-2.5",
      prompt: "a door creak",
      durationS: 3,
      seed: 7,
      promptInfluence: 0.4,
    },
  );
  const [record] = caller.records;
  assert.equal(record?.seed, 7);
  assert.deepEqual(record?.parameters, { durationS: 3, seed: 7, promptInfluence: 0.4 });
});

test("the prompt policy covers audio calls: a blocklisted prompt is refused before any call", async () => {
  const term = packageBlocklist().terms.find(
    (t) => t.kind === "artist" && t.term.includes(" "),
  )!.term;
  const prompt = `rain on a tin roof, composed by ${term}`;
  const { caller, calls } = scripted(wav);
  await assert.rejects(
    () => caller.audio("audio", prompt),
    (error: unknown) => {
      assert.ok(error instanceof PromptRefusedError);
      assert.match(error.message, /the final audio prompt/);
      return true;
    },
  );
  assert.deepEqual(calls, []);
  const allowing = scripted(wav, {}, [term]);
  await allowing.caller.audio("audio", prompt);
  assert.equal(allowing.calls.length, 1);
});

test("a route that returns anything but WAV is refused at intake", async () => {
  const mp3 = scripted(() => ({
    audio: { mediaType: "audio/mpeg", bytes: new Uint8Array([0xff, 0xfb, 0x90, 0x00]) },
  }));
  await assert.rejects(
    () => mp3.caller.audio("audio", "wind"),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /refused at intake/);
      assert.match(error.message, /returned audio\/mpeg, not a WAV/);
      return true;
    },
  );
  // The vendor charged the call: it settles and is recorded, but its output never comes back.
  assert.equal(mp3.caller.records.length, 1);
  const named = scripted(() => ({
    audio: { mediaType: "audio/wav", bytes: new TextEncoder().encode("OggS not a wav file") },
  }));
  await assert.rejects(() => named.caller.audio("audio", "wind"), /refused at intake/);
});

test("each call records its route's terms, the account's plan and the developer's declared training opt-out", async () => {
  const { caller } = scripted(() => ({ ...wav(), plan: "pro" }), {
    roles: {
      audio: {
        provider: "scripted",
        model: "stable-audio-2.5",
        trainingOptOut: { optedOut: true, since: "2026-11-20" },
      },
    },
  });
  await caller.audio("audio", "a footstep on gravel", { parameters: { durationS: 1 } });
  const [record] = caller.records;
  assert.match(record!.providerTerms!, /Stability assigns its rights in output to you/);
  assert.match(record!.providerTerms!, /Training on inputs and outputs is on by default/);
  assert.equal(record!.providerTermsAsOf, "2026-11-18");
  assert.equal(record!.outputGrant?.plan, "pro");
  assert.equal(record!.outputGrant?.license, "LicenseRef-stability-api");
  assert.deepEqual(record!.trainingOptOut, {
    optedOut: true,
    since: "2026-11-20",
    source: "declared by the developer",
  });
  assert.equal(record!.costUsd, 0.08);

  const undeclared = scripted(wav);
  await undeclared.caller.audio("audio", "a footstep on gravel");
  assert.equal(undeclared.caller.records[0]!.trainingOptOut, undefined, "never assumed");
  assert.equal(undeclared.caller.records[0]!.outputGrant?.plan, "api");
});

const adapter = (id: string) => CORE_ADAPTERS.find((a) => a.id === id)!;

function routeProviders(...ids: [string, string][]): RouteProvider[] {
  return ids.map(([id, adapterId]) => ({ id, adapter: adapter(adapterId), settings: {} }));
}

test("the refused audio routes are refused with their reasons", () => {
  const providers = [
    ...routeProviders(["stability", "stability"], ["elevenlabs", "elevenlabs"]),
    ...routeProviders(["gateway", "vercel-ai-gateway"], ["host", "openai-compatible"]),
  ];
  const cases: [string, string, RegExp, Record<string, unknown>?][] = [
    ["host", "facebook/musicgen-large", /licensed CC BY-NC.*a sold game is commercial/],
    ["host", "some/model", /licensed CC BY-NC/, { outputGrant: { license: "CC-BY-NC-4.0" } }],
    [
      "host",
      "stabilityai/stable-audio-open-1.0",
      /open-weight Stable Audio hosted by a third party.*Community License needs registration.*\$1,000,000/,
    ],
    [
      "gateway",
      "elevenlabs/eleven_text_to_sound_v3",
      /ElevenLabs through the AI Gateway.*which ElevenLabs rights tier applies/,
    ],
    ["elevenlabs", "music_v1", /Eleven Music.*Indie Game definition/],
    ["elevenlabs", "eleven_music_v1", /Eleven Music.*Indie Game definition/],
    ["host", "eleven_music", /Eleven Music.*Indie Game definition/],
    ["host", "suno/v4", /no public API/],
  ];
  for (const [provider, model, reason, extra] of cases) {
    assert.throws(
      () =>
        resolveRoute(
          {
            roles: { audio: { provider, model, estimatedCostUsd: 1, ...extra } },
            routes: {},
          } as never,
          "audio",
          providers,
        ),
      (error: unknown) => {
        assert.ok(error instanceof RouteUnavailableError, model);
        assert.match(error.message, /a refused audio route/);
        assert.match(error.message, reason);
        return true;
      },
    );
  }
  // Another vendor's music model is not Eleven Music: what refuses it here is the host's
  // missing audio capability, never the Eleven Music reason.
  assert.throws(
    () =>
      resolveRoute(
        {
          roles: { audio: { provider: "host", model: "music-01", estimatedCostUsd: 1 } },
          routes: {},
        } as never,
        "audio",
        providers,
      ),
    (error: unknown) => {
      assert.ok(error instanceof RouteUnavailableError);
      assert.doesNotMatch(error.message, /Eleven Music|refused audio route/);
      assert.match(error.message, /no audio capability/);
      return true;
    },
  );
  // Other roles are untouched by the audio refusals.
  const vision = resolveRoute(
    {
      roles: {},
      routes: { vision: { provider: "host", model: "suno/v4", estimatedCostUsd: 1 } },
    } as never,
    "vision",
    providers,
  );
  assert.equal(vision.model, "suno/v4");
});

test("Stable Audio 3.0, named in settings, takes its own terms, grant and estimate", () => {
  const providers = routeProviders(["stability", "stability"]);
  const byDefault = resolveRoute({ roles: {}, routes: {} } as never, "audio", providers);
  assert.equal(byDefault.model, "stable-audio-2.5");
  const route = resolveRoute(
    { roles: { audio: { provider: "stability", model: "stable-audio-3.0" } }, routes: {} } as never,
    "audio",
    providers,
  );
  assert.equal(route.model, "stable-audio-3.0");
  assert.equal(route.estimatedCostUsd, 0.08);
  assert.equal(route.supportsSeed, true);
  assert.match(route.providerTerms!, /Stability assigns its rights/);
  assert.equal(route.outputGrant?.license, "LicenseRef-stability-api");
  // A kind's own audio operation takes the role's default.
  const kindOperation = resolveRoute({ roles: {}, routes: {} } as never, "fx:sfx", providers, {
    "fx:sfx": "audio",
  });
  assert.equal(kindOperation.model, "stable-audio-2.5");
});

// --- The real adapters, made by core from settings, over scripted HTTP ---

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Seen {
  url: URL;
  method: string;
  body: string;
}

/** ElevenLabs' subscription answer, every field the SDK checks. */
function subscription(tier: string): Record<string, unknown> {
  return {
    tier,
    character_count: 0,
    character_limit: 100000,
    max_credit_limit_extension: 0,
    can_extend_character_limit: false,
    allowed_to_extend_character_limit: false,
    voice_slots_used: 0,
    professional_voice_slots_used: 0,
    professional_voice_slots_used_in_workspace: 0,
    voice_limit: 10,
    voice_add_edit_counter: 0,
    professional_voice_limit: 1,
    can_extend_voice_limit: false,
    can_use_instant_voice_cloning: true,
    can_use_professional_voice_cloning: false,
    current_overage: { amount: "0", currency: "usd" },
    status: "active",
    open_invoices: [],
    has_open_invoices: false,
  };
}

/** Replaces the global fetch the guarded fetch reaches, answering the vendors' endpoints. */
function vendor(tier: string): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push({ url, method: request.method, body: await request.text() });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/user/subscription") return json(subscription(tier));
    if (url.pathname === "/v1/sound-generation")
      return new Response(WAV, {
        headers: { "content-type": "audio/wav", "request-id": "el-req-1" },
      });
    if (url.pathname === "/v2beta/audio/stable-audio-2/text-to-audio")
      return new Response(WAV, { headers: { "content-type": "audio/wav", seed: "11" } });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return seen;
}

const env = { ELEVENLABS_API_KEY: "test-key-el", STABILITY_API_KEY: "test-key-st" };

function audioSet(providers: Record<string, unknown>, roles: Record<string, unknown> = {}) {
  return ProviderSet.fromSettings(
    { providers, roles, routes: {}, path: "settings.json" } as never,
    { env },
  );
}

async function paid<T>(body: () => Promise<T>): Promise<T> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "audio-calls-")));
  const clearance = { digest: "d", record: {} } as unknown as Clearance;
  return withRunScope({ journal: new Journal(dir, "run-1"), clearance }, body);
}

test("ElevenLabs, made from settings, calls through the guarded fetch, reserves the per-minute rate and records its tier and terms", async () => {
  const seen = vendor("pro");
  const set = audioSet({ elevenlabs: { limit: LIMIT } });
  const budget = new Budget(5);
  const caller = new Caller({ provider: set, budget, routes: set.routes });
  const audio = await paid(() =>
    caller.audio("audio", "a glass shatters", {
      parameters: { durationS: 10, promptInfluence: 0.5, seed: 3 },
    }),
  );
  assert.deepEqual(audio.bytes, WAV);
  const generation = seen.find((s) => s.url.pathname === "/v1/sound-generation")!;
  assert.equal(generation.url.host, "api.elevenlabs.io");
  assert.equal(generation.url.searchParams.get("output_format"), "wav_44100");
  const body = JSON.parse(generation.body) as Record<string, unknown>;
  assert.equal(body["model_id"], "eleven_text_to_sound_v3");
  assert.equal(body["duration_seconds"], 10);
  assert.equal(body["prompt_influence"], 0.5);
  assert.equal(body["seed"], undefined, "the route has no seed");
  const [record] = caller.records;
  assert.ok(Math.abs(record!.costUsd - (0.12 * 10) / 60) < 1e-12);
  assert.equal(record!.requestId, "el-req-1");
  assert.equal(record!.outputGrant?.plan, "pro");
  assert.equal(record!.outputGrant?.exclusive, false);
  assert.equal(
    grantOf(caller.records)?.exclusive,
    false,
    "the asset's own grant says non-exclusive",
  );
  assert.match(record!.providerTerms!, /non-exclusive/);
  assert.match(record!.providerTerms!, /"Data use" opt-out/);
  assert.equal(record!.seed, undefined);
});

test("Stability, made from settings, is priced at 8 credits through usdPerCredit and maps no promptInfluence", async () => {
  const seen = vendor("pro");
  // A credit priced above the published $0.01 puts the call above its route's estimate: refused.
  const dear = audioSet({ stability: { limit: LIMIT, usdPerCredit: 0.02 } });
  const refused = new Caller({ provider: dear, budget: new Budget(5), routes: dear.routes });
  await assert.rejects(
    () => paid(() => refused.audio("audio", "thunder")),
    /estimates the audio call at \$0\.1600, above the \$0\.0800/,
  );
  assert.equal(seen.length, 0);
  const set = audioSet({ stability: { limit: LIMIT, usdPerCredit: 0.005 } });
  const caller = new Caller({ provider: set, budget: new Budget(5), routes: set.routes });
  await assert.rejects(
    () => paid(() => caller.audio("audio", "thunder", { parameters: { promptInfluence: 0.3 } })),
    (error: unknown) => {
      assert.ok(error instanceof RouteUnavailableError);
      assert.match(error.message, /passes promptInfluence, which provider "stability"/);
      return true;
    },
  );
  assert.equal(seen.length, 0, "refused before any request");
  await paid(() => caller.audio("audio", "thunder", { parameters: { durationS: 2, seed: 11 } }));
  const [record] = caller.records;
  assert.equal(record!.costUsd, 0.04);
  assert.equal(record!.costSource, "provider");
  const form = seen[0]!;
  assert.equal(form.url.host, "api.stability.ai");
  assert.match(form.body, /name="output_format"\r\n\r\nwav/);
  assert.match(form.body, /name="seed"\r\n\r\n11/);
});

test("Stable Audio 3.0 through core: a rate-limited poll keeps the job journaled and a resumed run collects it without a second submit", async () => {
  const seen: Seen[] = [];
  let poll = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push({ url, method: request.method, body: "" });
    if (url.pathname === "/v2beta/audio/stable-audio-3/text-to-audio")
      return new Response(JSON.stringify({ id: "job-3" }), {
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/v2beta/results/job-3")
      return poll++ === 0
        ? new Response(JSON.stringify({ name: "rate_limited", errors: ["slow down"] }), {
            status: 429,
            headers: { "content-type": "application/json" },
          })
        : new Response(WAV, { headers: { "content-type": "audio/wav" } });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const set = audioSet(
    { stability: { limit: LIMIT } },
    { audio: { provider: "stability", model: "stable-audio-3.0" } },
  );
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "audio-resume-")));
  const clearance = { digest: "d", record: {} } as unknown as Clearance;
  const run = () => {
    const caller = new Caller({
      provider: set,
      budget: new Budget(5),
      routes: set.routes,
      jobPolling: { firstMs: 0, maxMs: 0, sleep: async () => {} },
    });
    return withRunScope({ journal: new Journal(dir, "run-1"), clearance }, () =>
      caller.audio("audio", "rain on a tin roof", { parameters: { durationS: 2 } }),
    );
  };
  await assert.rejects(run, /job job-3 could not be collected: .*slow down \(HTTP 429/);
  const posts = () => seen.filter((s) => s.method === "POST").length;
  assert.equal(posts(), 1, "the rate limit settles nothing and submits nothing again");
  const audio = await run();
  assert.deepEqual(audio.bytes, WAV);
  assert.equal(posts(), 1, "the resumed run fetches the stored job without a second submit");
});

test("at plan, the ElevenLabs tier is read: a free tier and a sample rate the tier doesn't allow are refused", async () => {
  const job = (provider: string) => ({
    operation: "audio",
    provider,
    model: "eleven_text_to_sound_v3",
    count: 1,
    estimatedCostUsd: 0.06,
  });
  vendor("free");
  await assert.rejects(
    () => checkAccounts(audioSet({ elevenlabs: { limit: LIMIT } }), [job("elevenlabs")]),
    (error: unknown) => {
      assert.ok(error instanceof RouteUnavailableError);
      assert.match(error.message, /on the free plan \(elevenlabs subscription\)/);
      assert.match(error.message, /free plans are non-commercial only/);
      return true;
    },
  );
  vendor("creator");
  await assert.rejects(
    () => checkAccounts(audioSet({ elevenlabs: { limit: LIMIT } }), [job("elevenlabs")]),
    /a 44100 Hz sample rate needs the Pro plan or above, and the account is on creator/,
  );
  const seen = vendor("creator");
  const lower = audioSet(
    { elevenlabs: { limit: LIMIT } },
    {
      audio: {
        provider: "elevenlabs",
        model: "eleven_text_to_sound_v3",
        providerOptions: { elevenlabs: { sampleRate: 22050 } },
      },
    },
  );
  await checkAccounts(lower, [job("elevenlabs")]);
  assert.deepEqual(
    seen.map((s) => s.url.pathname),
    ["/v1/user/subscription"],
    "the plan reads the tier and spends nothing",
  );
});

test("a plan for a kind whose operation has role audio, routed to ElevenLabs on a free tier, exits 2 route_unavailable before any call", async () => {
  const pack = {
    api: 3,
    name: "foley",
    kinds: [
      {
        kind: "foley:cue",
        operations: { "foley:sfx": "audio" },
        planCandidate: () => [],
        generate: () => Promise.reject(new Error("not called")),
      },
    ],
  } as unknown as Extension;
  const { operations } = new ExtensionRegistry([
    CORE_ENTRY,
    { extension: pack, info: { package: "foley-pack", version: "1.0.0", entry: "/x/index.js" } },
  ]);
  const plan = (tier: string) => {
    const seen = vendor(tier);
    const set = ProviderSet.fromSettings(
      {
        providers: { elevenlabs: { limit: LIMIT } },
        roles: { audio: { provider: "elevenlabs", model: "eleven_text_to_sound_v3" } },
        routes: {},
        path: "settings.json",
      } as never,
      { env, operations },
    );
    const route = set.routes["foley:sfx"]!;
    assert.equal(route.provider, "elevenlabs");
    const calls = [{ operation: "foley:sfx", model: route.model, estimatedCostUsd: 0.06 }];
    const built = buildWorkPlan(
      { name: "make", input: { type: "object", properties: {}, additionalProperties: false } },
      {},
      {
        inputs: [],
        jobs: jobsOf(calls, set.routes),
        capUsd: 1,
        paid: true,
        providers: set,
        candidates: 1,
      },
    );
    return { built, seen };
  };
  const free = plan("free");
  await assert.rejects(free.built, (error: unknown) => {
    assert.ok(error instanceof RouteUnavailableError);
    assert.equal(error.code, "route_unavailable");
    assert.equal(EXIT[error.code], 2);
    assert.match(error.message, /on the free plan \(elevenlabs subscription\)/);
    return true;
  });
  assert.deepEqual(
    free.seen.map((s) => s.url.pathname),
    ["/v1/user/subscription"],
    "the plan reads the tier and makes no generation call",
  );
  const pro = plan("pro");
  assert.equal((await pro.built).jobs[0]!.operation, "foley:sfx");
});

test("doctor reads each ElevenLabs account and reports a free tier as a provider-account finding", async () => {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "audio-doctor-")));
  const profile = join(dir, "profile.json");
  await writeFile(profile, JSON.stringify(syntheticProfile()));
  const ctx = (tier: string) => {
    vendor(tier);
    return {
      settings: {
        stateDir,
        configDir: dirname(settingsPath),
        path: "settings.json",
        providers: { elevenlabs: { limit: LIMIT }, stability: { limit: LIMIT } },
        roles: { audio: { provider: "stability", model: "stable-audio-2.5" } },
        routes: {},
      },
      env,
    } as unknown as RunContext;
  };
  const free = await doctorCommand.run({ profile, target: dir }, ctx("free"));
  assert.equal(free.exitCode, 0);
  const findings = (free.fields as { findings: { code: string; problem: string }[] }).findings;
  const account = findings.filter((f) => f.code === "provider-account");
  assert.equal(account.length, 1);
  assert.match(account[0]!.problem, /provider "elevenlabs" is on the free plan/);
  const pro = await doctorCommand.run({ profile, target: dir }, ctx("pro"));
  const none = (pro.fields as { findings: { code: string }[] }).findings;
  assert.equal(
    none.some((f) => f.code === "provider-account"),
    false,
  );
});
