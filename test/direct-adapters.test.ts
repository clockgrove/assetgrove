import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ProviderError } from "../src/errors.ts";
import { CORE_ADAPTERS, createProvider } from "../src/providers/adapter.ts";
import { suggestRoles } from "../src/providers/index.ts";
import { defaultRoutes, ROLE_CAPABILITY, roleOf } from "../src/routes.ts";
import type { Routes } from "../src/routes.ts";
import { DEFAULT_CAPS } from "../src/settings.ts";
import { SpendLedger } from "../src/spend.ts";
import { writeSettings } from "./fixtures/env.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The role coverage of design section 12: the roles each core adapter's default routes serve. */
const COVERAGE: Record<string, string[]> = {
  "vercel-ai-gateway": ["decisions", "edit", "image", "planning", "vision"],
  anthropic: ["decisions", "planning", "vision"],
  openai: ["decisions", "edit", "image", "planning", "vision"],
  // What the server offers: settings route each role to it.
  "openai-compatible": [],
  tripo: ["clips3d", "model3d", "rig3d"],
  scripted: ["clips3d", "decisions", "edit", "image", "model3d", "planning", "rig3d", "vision"],
};

test("the role coverage table per adapter: each core adapter's default routes serve its roles, each with a grant, terms and the capability", () => {
  assert.deepEqual(CORE_ADAPTERS.map((a) => a.id).sort(), Object.keys(COVERAGE).sort());
  for (const adapter of CORE_ADAPTERS) {
    const routes = adapter.defaultRoutes ?? {};
    const roles = [...new Set(Object.keys(routes).map((op) => roleOf(op)!))].sort();
    assert.deepEqual(roles, COVERAGE[adapter.id], adapter.id);
    for (const [operation, route] of Object.entries(routes)) {
      const capability = ROLE_CAPABILITY[roleOf(operation)!]!;
      assert.ok(
        (adapter.capabilities as string[]).includes(capability),
        `${adapter.id} ${operation} needs ${capability}`,
      );
      assert.ok(route.outputGrant, `${adapter.id} ${operation} has a grant`);
      assert.ok(route.providerTerms, `${adapter.id} ${operation} has terms`);
      assert.ok(route.estimatedCostUsd > 0, `${adapter.id} ${operation} has an estimate`);
    }
    // A role it serves, it serves for every core operation of that role.
    for (const operation of Object.keys(defaultRoutes)) {
      const role = roleOf(operation);
      if (role !== undefined && COVERAGE[adapter.id]!.includes(role))
        assert.ok(routes[operation], `${adapter.id} serves ${operation}`);
    }
  }
  const anthropic = CORE_ADAPTERS.find((a) => a.id === "anthropic")!;
  assert.deepEqual(anthropic.capabilities, ["vision", "decide"]);
  assert.equal(anthropic.endpointFromSettings, false);
  assert.deepEqual(anthropic.fixedHosts, ["api.anthropic.com"]);
  const openai = CORE_ADAPTERS.find((a) => a.id === "openai")!;
  assert.deepEqual(openai.capabilities, ["image", "edit", "vision", "decide"]);
  assert.equal(openai.endpointFromSettings, false);
  assert.deepEqual(openai.fixedHosts, ["api.openai.com"]);
});

test("suggestRoles(['anthropic']) leaves image and edit empty; every core adapter together covers every role", () => {
  const anthropic = suggestRoles(["anthropic"]);
  assert.equal(anthropic["image"], undefined);
  assert.equal(anthropic["edit"], undefined);
  assert.deepEqual(Object.keys(anthropic).sort(), ["decisions", "planning", "vision"]);
  for (const role of ["decisions", "planning", "vision"])
    assert.equal(anthropic[role]?.provider, "anthropic");

  const openai = suggestRoles(["openai"]);
  assert.deepEqual(Object.keys(openai).sort(), COVERAGE["openai"]);
  assert.deepEqual(suggestRoles(["openai-compatible"]), {});

  const both = suggestRoles(["anthropic", "openai"]);
  assert.equal(both["vision"]?.provider, "anthropic");
  assert.equal(both["image"]?.provider, "openai");
  assert.equal(both["edit"]?.provider, "openai");

  const all = suggestRoles(CORE_ADAPTERS.map((a) => a.id));
  assert.deepEqual(Object.keys(all).sort(), COVERAGE["scripted"]);
});

test("anthropic and openai are paid, declared only, on their fixed host even with *_BASE_URL set, and a missing key fails naming its variable before any call", async () => {
  const saved = { a: process.env["ANTHROPIC_BASE_URL"], o: process.env["OPENAI_BASE_URL"] };
  process.env["ANTHROPIC_BASE_URL"] = "http://127.0.0.1:9/anthropic";
  process.env["OPENAI_BASE_URL"] = "http://127.0.0.1:9/openai";
  try {
    for (const [id, host, keyEnv] of [
      ["anthropic", "api.anthropic.com", "ANTHROPIC_API_KEY"],
      ["openai", "api.openai.com", "OPENAI_API_KEY"],
    ] as const) {
      const keyed = createProvider(
        id,
        { limit: { kind: "key-budget", usd: 5 } },
        {
          env: { [keyEnv]: "direct-test-key-0123456789" },
        },
      );
      assert.equal(keyed.keyPresent, true);
      assert.equal(keyed.keyEnv, keyEnv);
      assert.deepEqual(keyed.provider.billing.hosts, [host]);
      assert.equal(keyed.provider.billing.paid, true);
      assert.equal(keyed.provider.billing.adapter, id);
      assert.equal(keyed.provider.billing.reconcile, "unavailable");
      assert.equal(keyed.provider.billing.readLimit, undefined, "declared only");

      const { provider } = createProvider(id, {}, { env: {} });
      await assert.rejects(
        provider.analyzeImages({ model: "m", prompt: "hello", images: [] }),
        (error: Error) =>
          error instanceof ProviderError && error.message.includes(`${keyEnv} is not set`),
      );
    }
  } finally {
    for (const [name, value] of [
      ["ANTHROPIC_BASE_URL", saved.a],
      ["OPENAI_BASE_URL", saved.o],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["src/cli.ts", ...args], { cwd: root }, (error, stdout, stderr) =>
      resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
}

test("free true on a non-loopback openai-compatible host and baseURL on anthropic each exit 2 settings_invalid", async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [
      {
        hosted: {
          adapter: "openai-compatible",
          baseURL: "https://models.example/v1",
          free: true,
        },
      },
      /hosted\.free is allowed only with a loopback baseURL/,
    ],
    [{ anthropic: { baseURL: "https://relay.example/v1" } }, /anthropic\.baseURL is not accepted/],
    [{ openai: { baseURL: "https://relay.example/v1" } }, /openai\.baseURL is not accepted/],
  ];
  for (const [providers, message] of cases) {
    writeSettings({ providers });
    const r = await cli(["settings", "show", "--json"]);
    assert.equal(r.code, 2, r.stderr);
    const document = JSON.parse(r.stdout) as { error: { code: string; message: string } };
    assert.equal(document.error.code, "settings_invalid");
    assert.match(document.error.message, message);
  }
});

test("openai-compatible is paid unless free on loopback, and its structured-output decision records decisionSource", async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "application/json", "x-request-id": "req-local-1" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 0,
          model: "local-chat",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: JSON.stringify({ score: 3 }) },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  try {
    const paid = createProvider("chat", { adapter: "openai-compatible", baseURL }, { env: {} });
    assert.equal(paid.provider.billing.paid, true, "paid unless settings mark it free");
    const { provider, id } = createProvider(
      "chat",
      { adapter: "openai-compatible", baseURL, free: true },
      { env: {} },
    );
    assert.equal(provider.billing.paid, false);
    const stateDir = await mkdtemp(join(tmpdir(), "assetgrove-direct-"));
    const ledger = SpendLedger.fromSettings({ stateDir, caps: { ...DEFAULT_CAPS } }, { env: {} });
    const routes = {
      ...defaultRoutes,
      identity: { provider: id, model: "local-chat", estimatedCostUsd: 0 },
    } as Routes;
    const caller = new Caller({
      provider,
      providerName: id,
      budget: new Budget(1, ledger),
      routes,
    });
    const { result, record } = await caller.decide("identity", "Image 1 is the candidate.", [], {
      type: "score",
      instructions: "How well does it match?",
      levels: ["no", "barely", "partly", "mostly", "fully"],
    });
    assert.deepEqual(result.answer, { type: "score", score: 3 });
    assert.equal(result.decisionSource, "structured-output");
    assert.equal(record.decision?.decisionSource, "structured-output");
    assert.equal(record.decision?.raw, 3);
    const format = bodies[0]?.["response_format"] as { type?: string } | undefined;
    assert.equal(format?.type, "json_schema", "asked through structured output");
  } finally {
    server.close();
  }
});
