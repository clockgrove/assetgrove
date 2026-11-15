import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ProviderError } from "../src/errors.ts";
import { CORE_ADAPTERS, createProvider } from "../src/providers/adapter.ts";
import { suggestRoles } from "../src/providers/set.ts";
import { defaultRoutes, OPERATION_ROLES, ROLE_CAPABILITY } from "../src/routes.ts";
import { DEFAULT_CAPS } from "../src/settings.ts";
import { SpendLedger } from "../src/spend.ts";
import { writeSettings } from "./fixtures/env.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["src/cli.ts", ...args], { cwd: root }, (error, stdout, stderr) =>
      resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
}

const ALL_ROLES = [
  "image",
  "edit",
  "vision",
  "decisions",
  "planning",
  "model3d",
  "rig3d",
  "clips3d",
];

const COVERAGE: Record<string, { roles: string[]; capabilities: string[] }> = {
  "vercel-ai-gateway": {
    roles: ["image", "edit", "vision", "decisions", "planning"],
    capabilities: ["image", "edit", "vision", "decide"],
  },
  anthropic: {
    roles: ["vision", "decisions", "planning"],
    capabilities: ["vision", "decide"],
  },
  openai: {
    roles: ["image", "edit", "vision", "decisions", "planning"],
    capabilities: ["image", "edit", "vision", "decide"],
  },
  "openai-compatible": { roles: [], capabilities: ["image", "edit", "vision", "decide"] },
  tripo: { roles: ["model3d", "rig3d", "clips3d"], capabilities: ["model", "rig", "animate"] },
  scripted: {
    roles: ALL_ROLES,
    capabilities: ["image", "edit", "vision", "decide", "model", "rig", "animate"],
  },
};

test("every core adapter is in the role coverage table, with its roles and capabilities", () => {
  assert.deepEqual(
    CORE_ADAPTERS.map((a) => a.id).sort(),
    Object.keys(COVERAGE).sort(),
    "a new adapter must be added to the coverage table",
  );
  for (const adapter of CORE_ADAPTERS) {
    const expected = COVERAGE[adapter.id]!;
    assert.deepEqual(
      Object.keys(suggestRoles([adapter.id])).sort(),
      [...expected.roles].sort(),
      `${adapter.id} roles`,
    );
    assert.deepEqual(
      [...adapter.capabilities].sort(),
      [...expected.capabilities].sort(),
      `${adapter.id} capabilities`,
    );
  }
});

test("every default route names an operation whose role the adapter can serve", () => {
  for (const adapter of CORE_ADAPTERS) {
    for (const [operation, route] of Object.entries(adapter.defaultRoutes ?? {})) {
      const role = Object.hasOwn(OPERATION_ROLES, operation)
        ? OPERATION_ROLES[operation]
        : undefined;
      assert.ok(role !== undefined, `${adapter.id}: ${operation} is a known operation`);
      const capability = ROLE_CAPABILITY[role]!;
      assert.ok(
        (adapter.capabilities as string[]).includes(capability),
        `${adapter.id}: ${operation} needs ${capability}`,
      );
      if (adapter.id === "anthropic" || adapter.id === "openai") {
        assert.ok(route.outputGrant, `${adapter.id}: ${operation} has an outputGrant`);
        assert.ok(route.providerTerms, `${adapter.id}: ${operation} has providerTerms`);
      }
    }
  }
});

test("suggestRoles leaves anthropic without image and edit, and takes each role from the first adapter that serves it", () => {
  const alone = suggestRoles(["anthropic"]);
  assert.equal(alone["image"], undefined);
  assert.equal(alone["edit"], undefined);
  const both = suggestRoles(["anthropic", "openai"]);
  assert.equal(both["image"]?.provider, "openai");
  assert.equal(both["edit"]?.provider, "openai");
  assert.equal(both["vision"]?.provider, "anthropic");
});

test("free true on a non-loopback openai-compatible host and baseURL on anthropic or openai each exit 2 settings_invalid", async () => {
  const cases: Record<string, unknown>[] = [
    { local: { adapter: "openai-compatible", baseURL: "https://models.example/v1", free: true } },
    { anthropic: { baseURL: "https://relay.example/v1" } },
    { openai: { baseURL: "https://relay.example/v1" } },
  ];
  for (const providers of cases) {
    writeSettings({ providers });
    const r = await cli(["settings", "show", "--json"]);
    assert.equal(r.code, 2, r.stderr);
    const document = JSON.parse(r.stdout) as { error: { code: string } };
    assert.equal(document.error.code, "settings_invalid");
  }
});

test("billing: anthropic and openai are paid at their fixed host; openai-compatible is free only on loopback", () => {
  for (const [id, host] of [
    ["anthropic", "api.anthropic.com"],
    ["openai", "api.openai.com"],
  ] as const) {
    const { billing } = createProvider(id, {}, { env: {} }).provider;
    assert.equal(billing.paid, true);
    assert.deepEqual(billing.hosts, [host]);
    assert.equal(billing.reconcile, "unavailable");
    assert.equal(billing.readLimit, undefined);
  }
  const base = { adapter: "openai-compatible", baseURL: "http://127.0.0.1:9/v1" };
  assert.equal(
    createProvider("local", { ...base, free: true }, { env: {} }).provider.billing.paid,
    false,
  );
  assert.equal(createProvider("local", base, { env: {} }).provider.billing.paid, true);
});

test("a decision through structured output records its decisionSource", async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      assert.equal(req.method, "POST");
      assert.match(req.url ?? "", /\/v1\/chat\/completions$/);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-fixture",
          object: "chat.completion",
          created: 1,
          model: "local-chat",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: '{"score": 3}' },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const { port } = server.address() as AddressInfo;
    const { provider, id } = createProvider(
      "local",
      { adapter: "openai-compatible", baseURL: `http://127.0.0.1:${port}/v1`, free: true },
      { env: {} },
    );
    const stateDir = await mkdtemp(join(tmpdir(), "assetgrove-direct-"));
    const ledger = SpendLedger.fromSettings({ stateDir, caps: { ...DEFAULT_CAPS } }, { env: {} });
    const caller = new Caller({
      provider,
      providerName: id,
      budget: new Budget(5, ledger),
      routes: {
        ...defaultRoutes,
        identity: { model: "local-chat", estimatedCostUsd: 0, provider: id },
      },
    });
    const { record } = await caller.decide("identity", "prompt", [], {
      type: "score",
      instructions: "x",
      levels: ["a", "b", "c", "d", "e"],
    });
    assert.equal(record.decision?.decisionSource, "structured-output");
  } finally {
    server.close();
  }
});

test("an anthropic decision without its key fails naming ANTHROPIC_API_KEY, without any network", async () => {
  const { provider } = createProvider("anthropic", {}, { env: {} });
  await assert.rejects(
    provider.decide!({
      model: "claude-sonnet-4-5",
      prompt: "prompt",
      images: [],
      question: { type: "score", instructions: "x", levels: ["a", "b"] },
    }),
    (error: Error) => {
      assert.ok(error instanceof ProviderError, error.message);
      assert.match(error.message, /ANTHROPIC_API_KEY/);
      return true;
    },
  );
});
