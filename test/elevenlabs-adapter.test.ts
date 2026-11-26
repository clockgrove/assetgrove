import assert from "node:assert/strict";
import { test } from "node:test";
import wavefile from "wavefile";
import { ProviderError } from "../src/errors.ts";
import { ELEVENLABS_BASE_URL, ElevenLabsProvider } from "../src/gateway/elevenlabs.ts";
import { ProviderQuotaError } from "../src/gateway/failure.ts";

const { WaveFile } = wavefile;
const MODEL = "eleven_text_to_sound_v2";
const KEY = "synthetic-key-not-real";

interface Seen {
  url: URL;
  method: string;
  headers: Headers;
  body: string;
}

function tinyWav(): Uint8Array {
  const wav = new WaveFile();
  wav.fromScratch(1, 44100, "16", [0, 1000, -1000, 500]);
  return wav.toBuffer();
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A subscription body with every field the SDK's response check requires. */
function subscription(tier = "pro"): Record<string, unknown> {
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

/** A fake fetch that records each request and answers subscription and sound-generation calls. */
function script(options: { tier?: string; sound?: () => Response }): {
  seen: Seen[];
  fetch: typeof fetch;
} {
  const seen: Seen[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push({
      url,
      method: request.method,
      headers: request.headers,
      body: await request.text(),
    });
    if (url.pathname === "/v1/user/subscription") return json(200, subscription(options.tier));
    if (url.pathname === "/v1/sound-generation") {
      return (
        options.sound?.() ??
        new Response(tinyWav(), {
          status: 200,
          headers: { "content-type": "audio/wav", "request-id": "req-123" },
        })
      );
    }
    return json(404, { detail: { status: "not_found" } });
  };
  return { seen, fetch: fake as typeof fetch };
}

function provider(fetchImpl: typeof fetch, apiKey: string | undefined = KEY) {
  return new ElevenLabsProvider({ apiKey, fetch: fetchImpl });
}

const keyless = (fetchImpl: typeof fetch) =>
  new ElevenLabsProvider({ apiKey: undefined, fetch: fetchImpl });

const sounds = (seen: Seen[]) => seen.filter((s) => s.url.pathname === "/v1/sound-generation");

test("a generation goes through the injected fetch and returns WAV with the tier", async () => {
  const { seen, fetch } = script({ tier: "creator" });
  const result = await provider(fetch).generateAudio({
    model: "eleven_text_to_sound_v2",
    prompt: "a wooden door creaks",
    durationS: 2.5,
    promptInfluence: 0.4,
    providerOptions: { elevenlabs: { sampleRate: 22050 } },
  });
  const [call] = sounds(seen);
  assert.ok(call);
  assert.equal(call.method, "POST");
  assert.equal(call.url.origin, ELEVENLABS_BASE_URL);
  assert.equal(call.url.searchParams.get("output_format"), "wav_22050");
  assert.equal(call.headers.get("xi-api-key"), KEY);
  const body = JSON.parse(call.body) as Record<string, unknown>;
  assert.equal(body["text"], "a wooden door creaks");
  assert.equal(body["model_id"], "eleven_text_to_sound_v2");
  assert.equal(body["duration_seconds"], 2.5);
  assert.equal(body["prompt_influence"], 0.4);
  assert.ok(!("seed" in body));
  assert.equal(result.plan, "creator");
  assert.equal(result.requestId, "req-123");
  assert.equal(result.requestIdSource, undefined);
  assert.equal(result.audio.mediaType, "audio/wav");
  const wav = new WaveFile(result.audio.bytes);
  assert.equal((wav.fmt as { sampleRate: number }).sampleRate, 44100);
  assert.equal(Buffer.from(result.audio.bytes.subarray(0, 4)).toString(), "RIFF");
});

test("a sound-generation answer keeps the media type ElevenLabs sent, so intake names it", async () => {
  const { fetch } = script({
    tier: "pro",
    sound: () =>
      new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), {
        status: 200,
        headers: { "content-type": "audio/mpeg; charset=binary" },
      }),
  });
  const result = await provider(fetch).generateAudio({ model: MODEL, prompt: "a bell" });
  assert.equal(result.audio.mediaType, "audio/mpeg");
});

test("the default sample rate is 44100 on a Pro account, and a missing request id is local", async () => {
  const { seen, fetch } = script({
    tier: "pro",
    sound: () => new Response(tinyWav(), { status: 200 }),
  });
  const result = await provider(fetch).generateAudio({ model: MODEL, prompt: "p" });
  assert.equal(sounds(seen)[0]?.url.searchParams.get("output_format"), "wav_44100");
  assert.equal(result.requestIdSource, "local");
  assert.ok(result.requestId.length > 0);
});

test("the free tier is refused by checkAccount and by generateAudio before the paid request", async () => {
  const { seen, fetch } = script({ tier: "free" });
  const p = provider(fetch);
  const reading = await p.checkAccount();
  assert.equal(reading.plan, "free");
  assert.equal(reading.source, "elevenlabs subscription");
  assert.match(reading.refused ?? "", /non-commercial/);
  await assert.rejects(p.generateAudio({ model: MODEL, prompt: "p" }), ProviderError);
  assert.equal(sounds(seen).length, 0);
});

test("44100 needs Pro, 22050 does not, and an unknown rate is refused", async () => {
  const { seen, fetch } = script({ tier: "creator" });
  const p = provider(fetch);
  const route = (sampleRate: number) => ({
    operation: "audio",
    model: MODEL,
    providerOptions: { elevenlabs: { sampleRate } },
  });
  const high = await p.checkAccount(route(44100));
  assert.match(high.refused ?? "", /44100.*creator/);
  assert.match((await p.checkAccount(route(48000))).refused ?? "", /48000/);
  assert.equal((await p.checkAccount(route(22050))).refused, undefined);
  assert.equal((await p.checkAccount()).refused, undefined);
  assert.match((await p.checkAccount(route(12345))).refused ?? "", /12345/);
  await assert.rejects(p.generateAudio({ model: MODEL, prompt: "p" }), /44100/);
  assert.equal(sounds(seen).length, 0);
});

test("a Pro-or-above tier allows 44100", async () => {
  for (const tier of ["pro", "scale", "business", "growing_business", "enterprise"]) {
    const { fetch } = script({ tier });
    const reading = await provider(fetch).checkAccount({ operation: "audio", model: MODEL });
    assert.equal(reading.refused, undefined, tier);
  }
});

test("estimate is the per-minute rate, 30 seconds without a duration", () => {
  const p = provider(script({}).fetch);
  assert.ok(
    Math.abs(p.estimate({ model: MODEL, prompt: "p", durationS: 10 }, "audio") - 0.02) < 1e-12,
  );
  assert.ok(Math.abs(p.estimate({ model: MODEL, prompt: "p" }, "audio") - 0.06) < 1e-12);
  assert.throws(
    () => p.estimate({ model: MODEL, prompt: "p", durationS: 0.4 }, "audio"),
    ProviderError,
  );
  assert.throws(
    () => p.estimate({ model: MODEL, prompt: "p", durationS: 31 }, "audio"),
    ProviderError,
  );
});

test("a missing key fails each call without a request", async () => {
  const { seen, fetch } = script({});
  const p = keyless(fetch);
  await assert.rejects(p.generateAudio({ model: MODEL, prompt: "p" }), /ELEVENLABS_API_KEY/);
  await assert.rejects(p.checkAccount(), /ELEVENLABS_API_KEY/);
  assert.equal(seen.length, 0);
});

test("a 401 is a provider error and a 402 a quota refusal, with their status", async () => {
  const denied = script({
    sound: () => json(401, { detail: { status: "invalid_api_key", message: "secret body text" } }),
  });
  await assert.rejects(
    provider(denied.fetch).generateAudio({
      model: MODEL,
      prompt: "private prompt",
      providerOptions: { elevenlabs: { sampleRate: 22050 } },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.status, 401);
      assert.doesNotMatch(error.message, /secret body text|private prompt|synthetic-key/);
      return true;
    },
  );
  const quota = script({ sound: () => json(402, { detail: { status: "payment_required" } }) });
  await assert.rejects(
    provider(quota.fetch).generateAudio({ model: MODEL, prompt: "p" }),
    (error: unknown) => error instanceof ProviderQuotaError && error.status === 402,
  );
  const limited = script({ sound: () => json(429, { detail: { status: "too_many_requests" } }) });
  await assert.rejects(
    provider(limited.fetch).generateAudio({ model: MODEL, prompt: "p" }),
    (error: unknown) => error instanceof ProviderError && error.status === 429,
  );
});

test("the SDK does not retry a failed paid call", async () => {
  const { seen, fetch } = script({ sound: () => json(500, { detail: { status: "boom" } }) });
  await assert.rejects(
    provider(fetch).generateAudio({ model: MODEL, prompt: "p" }),
    (error: unknown) => error instanceof ProviderError && error.status === 500,
  );
  assert.equal(sounds(seen).length, 1);
});

test("image and vision calls are refused", async () => {
  const p = provider(script({}).fetch);
  await assert.rejects(p.generateImage(), /audio only/);
  await assert.rejects(p.analyzeImages(), /audio only/);
});

test("billing names the host and declares the cost", () => {
  const p = provider(script({}).fetch);
  assert.deepEqual(p.billing.hosts, ["api.elevenlabs.io"]);
  assert.equal(p.billing.settle, "declared");
  assert.equal(p.billing.reconcile, "unavailable");
  assert.deepEqual(p.audioParameters, ["durationS", "promptInfluence"]);
});
