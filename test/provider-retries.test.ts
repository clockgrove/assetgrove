import "./fixtures/env.ts";
import { cleared, stateDir } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ProviderError } from "../src/errors.ts";
import { AnthropicProvider } from "../src/gateway/anthropic.ts";
import { OpenAICompatibleProvider } from "../src/gateway/openai-compatible.ts";
import { OpenAIProvider } from "../src/gateway/openai.ts";
import type { Billing, GenerationProvider } from "../src/gateway/provider.ts";
import { VercelGateway } from "../src/gateway/vercel.ts";
import type { Routes } from "../src/routes.ts";
import { SpendLedger } from "../src/spend.ts";

const billing = (adapter: string): Omit<Billing, "hosts" | "readLimit"> => ({
  adapter,
  providerId: adapter,
  paid: true,
  settle: "declared",
  reconcile: "unavailable",
  limit: { kind: "prepaid", usd: 20 },
});

/** A loopback server that answers every request with `status`, counting them. */
async function failing(
  statuses: number[],
): Promise<{ url: string; count: () => number; close: () => Promise<void> }> {
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const status = statuses[Math.min(requests, statuses.length - 1)]!;
      requests++;
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: `status ${status}`, type: "server_error" } }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    count: () => requests,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

/** Sends every fetch of the body to `url`, keeping its path: the direct adapters' fixed hosts. */
async function redirected<T>(url: string, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    return original(`${url}${target.pathname}${target.search}`, init);
  };
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

const image = { mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) };
const question = { type: "boolean" as const, instructions: "Is it round?" };

test("a paid call that fails with a retryable status reaches the provider once, on one ledger reservation", async () => {
  const server = await failing([502]);
  try {
    const adapters: Array<[string, GenerationProvider, Array<"image" | "vision" | "decide">]> = [
      [
        "openai-compatible",
        new OpenAICompatibleProvider({
          baseURL: `${server.url}/v1`,
          billing: billing("openai-compatible"),
        }),
        ["image", "vision", "decide"],
      ],
      [
        "vercel-ai-gateway",
        new VercelGateway({
          apiKey: "gateway-test-key-0123",
          baseURL: `${server.url}/v4/ai`,
          billing: billing("vercel-ai-gateway"),
        }),
        ["image", "vision", "decide"],
      ],
      [
        "openai",
        new OpenAIProvider({ apiKey: "openai-test-key-0123", billing: billing("openai") }),
        ["image", "vision", "decide"],
      ],
      [
        "anthropic",
        new AnthropicProvider({ apiKey: "anthropic-test-key-0123", billing: billing("anthropic") }),
        ["vision", "decide"],
      ],
    ];
    const ledger = SpendLedger.fromSettings({
      stateDir,
      caps: { runUsd: 5, dailyUsd: 50, workItemUsd: 50 },
    });
    for (const [id, provider, kinds] of adapters) {
      for (const kind of kinds) {
        const before = server.count();
        const reservedBefore = reservations(ledger.path);
        const routes = { [kind]: { provider: id, model: "m", estimatedCostUsd: 0.25 } } as Routes;
        const caller = new Caller({
          provider,
          providerName: id,
          budget: new Budget(5, ledger),
          routes,
        });
        const call = (): Promise<unknown> =>
          kind === "image"
            ? caller.image(kind, "a small round icon", [])
            : kind === "vision"
              ? caller.vision(kind, "describe it", [])
              : caller.decide(kind, "is it round?", [], question);
        await assert.rejects(
          redirected(server.url, () => cleared(call)),
          ProviderError,
          `${id} ${kind} fails at the provider`,
        );
        assert.equal(server.count() - before, 1, `${id} ${kind}: one request`);
        assert.equal(
          reservations(ledger.path) - reservedBefore,
          1,
          `${id} ${kind}: one reservation`,
        );
      }
    }
  } finally {
    await server.close();
  }
});

test("a gateway decision refused with HTTP 429 is sent again; a 5xx after it is not", async () => {
  const server = await failing([429, 502]);
  try {
    const gateway = new VercelGateway({
      apiKey: "gateway-test-key-0123",
      baseURL: `${server.url}/v4/ai`,
    });
    await assert.rejects(
      gateway.decide({
        model: "m",
        prompt: "is it round?",
        images: [image],
        question,
        operation: "decide",
      }),
    );
    assert.equal(server.count(), 2);
  } finally {
    await server.close();
  }
});

function reservations(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.includes('"op":"reserve"')).length;
}
