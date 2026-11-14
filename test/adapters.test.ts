import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ProviderError } from "../src/errors.ts";
import type { GenerationProvider } from "../src/gateway/provider.ts";
import type { Script } from "../src/gateway/scripted.ts";
import { TripoProvider } from "../src/gateway/tripo.ts";
import { VercelGateway } from "../src/gateway/vercel.ts";
import { createProvider } from "../src/providers/adapter.ts";
import { defaultRoutes } from "../src/routes.ts";
import { loadSettings } from "../src/settings.ts";
import { SpendLedger } from "../src/spend.ts";
import { ledgerPath, settingsPath, writeSettings } from "./fixtures/env.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

const settings = () => loadSettings({ cwd: dirname(settingsPath) });

function script(paid: boolean): Script {
  return {
    ...(paid && { paid: true }),
    image: () => ({ images: [{ mediaType: "image/png", bytes: new Uint8Array([1]) }] }),
    vision: () => ({ text: "ok" }),
  };
}

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env: process.env },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
}

/** A loopback HTTP fixture answering every request with `status` and `body`, recording each. */
async function fixture(status: number, body: string, type = "application/json") {
  const seen: Array<{ path: string; auth: string | undefined }> = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", auth: req.headers.authorization });
    req.resume();
    res.writeHead(status, { "content-type": type });
    res.end(body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { seen, url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test("a scripted provider with paid true writes ledger entries; without it, none", async () => {
  const s = settings();
  for (const paid of [false, true]) {
    const provider = createProvider(s, "scripted", { script: script(paid) }) as GenerationProvider;
    assert.equal(provider.billing.adapter, "scripted");
    assert.equal(provider.billing.paid, paid);
    const call = new Caller({
      provider,
      providerName: "scripted",
      budget: new Budget(5, SpendLedger.fromSettings(s)),
      routes: defaultRoutes,
    });
    await call.image("still", "a fox", []);
    await call.vision("vision", "check", []);
    if (!paid) {
      assert.equal(existsSync(ledgerPath), false);
      continue;
    }
    const entries = readFileSync(ledgerPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { op: string; provider?: string });
    assert.equal(entries.filter((e) => e.op === "reserve").length, 2);
    assert.equal(entries.filter((e) => e.op === "settle").length, 2);
    assert.ok(entries.filter((e) => e.op === "reserve").every((e) => e.provider === "scripted"));
  }
});

test("with ANTHROPIC_BASE_URL and OPENAI_BASE_URL set, the gateway's host is its fixed host", () => {
  const env = {
    AI_GATEWAY_API_KEY: "synthetic-gateway-key",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9/anthropic",
    OPENAI_BASE_URL: "http://127.0.0.1:9/openai",
  };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const gateway = createProvider(settings(), "vercel-ai-gateway", { env }) as VercelGateway;
    assert.ok(gateway instanceof VercelGateway);
    assert.equal(new URL(gateway.baseURL).host, "ai-gateway.vercel.sh");
    assert.deepEqual(gateway.billing.hosts, ["ai-gateway.vercel.sh"]);
    assert.equal(gateway.billing.paid, true);
  } finally {
    for (const name of Object.keys(env)) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("a loopback settings baseURL is used, with the key from keyEnv", async () => {
  const server = await fixture(
    400,
    JSON.stringify({ error: { message: "fixture", type: "invalid_request_error" } }),
  );
  try {
    writeSettings({
      providers: {
        local: {
          adapter: "vercel-ai-gateway",
          keyEnv: "LOCAL_GATEWAY_KEY",
          baseURL: `${server.url}/v4/ai`,
          limit: { kind: "prepaid", usd: 1 },
        },
      },
    });
    const gateway = createProvider(settings(), "local", {
      env: { LOCAL_GATEWAY_KEY: "synthetic-local-key", AI_GATEWAY_API_KEY: "other" },
    }) as VercelGateway;
    assert.deepEqual(gateway.billing.hosts, [new URL(server.url).host]);
    await assert.rejects(
      gateway.analyzeImages({ model: "openai/gpt-5", prompt: "hello", images: [] }),
      ProviderError,
    );
    assert.ok(server.seen.length > 0, "the fixture received the call");
    for (const { path, auth } of server.seen) {
      assert.match(path, /^\/v4\/ai\//);
      assert.equal(auth, "Bearer synthetic-local-key");
    }
  } finally {
    server.close();
  }
});

test("baseURL on tripo and an unknown adapter id each exit 2 settings_invalid", async () => {
  for (const providers of [
    { tripo: { baseURL: "https://tripo.example/v2" } },
    { mine: { adapter: "no-such-adapter" } },
  ]) {
    writeSettings({ providers });
    const r = await cli(["spend", "check", "--json"]);
    assert.equal(r.code, 2, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.error.code, "settings_invalid");
    assert.match(doc.error.message, /baseURL is not accepted|no-such-adapter/);
  }
});

test("a provider error whose response body holds text never shows that body", async () => {
  const BODY = "BODY-TEXT-sk-synthetic-0123456789 internal trace";
  // The gateway: a text body and a JSON body whose extra fields carry the text.
  for (const [status, body, type] of [
    [500, BODY, "text/plain"],
    [400, JSON.stringify({ detail: BODY }), "application/json"],
  ] as const) {
    const server = await fixture(status, body, type);
    try {
      const gateway = new VercelGateway({ apiKey: "synthetic", baseURL: `${server.url}/v4/ai` });
      await assert.rejects(
        gateway.analyzeImages({ model: "openai/gpt-5", prompt: "hello", images: [] }),
        (error: Error) => {
          assert.ok(error instanceof ProviderError);
          assert.ok(!error.message.includes("BODY-TEXT"), error.message);
          assert.equal(error.cause, undefined);
          assert.match(error.message, new RegExp(`HTTP ${status}`));
          return true;
        },
      );
    } finally {
      server.close();
    }
  }
  // Tripo: a body that is not its JSON envelope.
  const tripo = new TripoProvider({
    apiKey: "synthetic",
    fetch: (async () => new Response(BODY, { status: 502 })) as typeof fetch,
  });
  await assert.rejects(tripo.balance(), (error: Error) => {
    assert.ok(error instanceof ProviderError);
    assert.ok(!error.message.includes("BODY-TEXT"), error.message);
    assert.match(error.message, /HTTP 502/);
    return true;
  });
});

test("keys and endpoints are passed explicitly: keyEnv, else the adapter's default", () => {
  writeSettings({ providers: { gw: { adapter: "vercel-ai-gateway", keyEnv: "GW_KEY" } } });
  const s = settings();
  assert.equal(
    (createProvider(s, "gw", { env: { GW_KEY: "k" } }) as VercelGateway).billing.provider,
    "gw",
  );
  const keyless = createProvider(s, "gw", { env: { AI_GATEWAY_API_KEY: "ignored" } });
  return assert.rejects(
    (keyless as VercelGateway).analyzeImages({ model: "m", prompt: "p", images: [] }),
    /GW_KEY is not set/,
  );
});

test("Tripo stays in core with its fixed host", () => {
  const tripo = createProvider(settings(), "tripo", { env: { TRIPO_API_KEY: "k" } });
  assert.ok(tripo instanceof TripoProvider);
  assert.deepEqual(tripo.billing.hosts, ["api.tripo3d.ai"]);
});
