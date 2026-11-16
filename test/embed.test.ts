/**
 * Embedding calls (issue #242, design section 7.7): the `embed` operation on the `embeddings`
 * role, served only by an adapter with the `embed` capability; `Caller.embed` journals each call,
 * so a resumed run pays for none twice; the gateway embeds an image only on a model that puts
 * images and text in one space.
 */
import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ProviderError } from "../src/errors.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { VercelGateway } from "../src/gateway/vercel.ts";
import { anthropicAdapter, scriptedAdapter } from "../src/providers/adapter.ts";
import { EMBED_OPERATION, RouteUnavailableError, resolveRoute } from "../src/routes.ts";
import type { Routes } from "../src/routes.ts";
import { Journal, withRunScope } from "../src/runs/journal.ts";
import type { LoadedReference } from "../src/types.ts";

const providers = [
  { id: "scripted", adapter: scriptedAdapter },
  { id: "anthropic", adapter: anthropicAdapter },
];

test("the embed operation is routed by the embeddings role, only to an adapter with embed", () => {
  const settings = (provider: string) => ({
    routes: {},
    roles: { embeddings: { provider, model: "m", estimatedCostUsd: 0.001 } },
  });
  const route = resolveRoute(settings("scripted"), EMBED_OPERATION, providers);
  assert.equal(route.provider, "scripted");
  assert.throws(
    () => resolveRoute(settings("anthropic"), EMBED_OPERATION, providers),
    (e: unknown) => e instanceof RouteUnavailableError && /no embed capability/.test(e.message),
  );
  // No adapter routes it by default: a hosted embedder is never chosen silently.
  assert.throws(
    () => resolveRoute({ routes: {}, roles: {} }, EMBED_OPERATION, providers),
    (e: unknown) => e instanceof RouteUnavailableError && /roles\.embeddings/.test(e.message),
  );
});

function image(): LoadedReference {
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  return {
    role: "search",
    path: "x",
    mediaType: "image/png",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

test("Caller.embed journals each call: a resumed run reserves and calls nothing again", async () => {
  const provider = new ScriptedProvider({
    image: () => ({ images: [] }),
    vision: () => ({ text: "" }),
    embed: (request) => ({
      vector: new Array<number>(request.dimensions).fill("text" in request.input ? 1 : 2),
      costUsd: 0.001,
    }),
  });
  const routes = {
    [EMBED_OPERATION]: { provider: "scripted", model: "m", estimatedCostUsd: 0.002 },
  } as unknown as Routes;
  const dir = mkdtempSync(join(tmpdir(), "assetgrove-embed-"));
  const once = async () => {
    const budget = new Budget(1);
    const caller = new Caller({ provider, providerName: "scripted", budget, routes });
    const journal = new Journal(dir, "r-0000000000000000");
    const vectors = await withRunScope({ journal }, async () => [
      await caller.embed(EMBED_OPERATION, { image: image() }, 4),
      await caller.embed(EMBED_OPERATION, { text: "a lantern" }, 4),
    ]);
    return { vectors, budget, caller };
  };
  const first = await once();
  assert.deepEqual(first.vectors, [
    [2, 2, 2, 2],
    [1, 1, 1, 1],
  ]);
  assert.equal(provider.calls.length, 2);
  assert.equal(first.caller.records[0]!.operation, EMBED_OPERATION);
  const resumed = await once();
  assert.deepEqual(resumed.vectors, first.vectors);
  assert.equal(provider.calls.length, 2, "the journal answers; the provider is not called again");
});

test("Caller.embed refuses a vector of another width", async () => {
  const provider = new ScriptedProvider({
    image: () => ({ images: [] }),
    vision: () => ({ text: "" }),
    embed: () => ({ vector: [1, 2, 3] }),
  });
  const routes = {
    [EMBED_OPERATION]: { provider: "scripted", model: "m", estimatedCostUsd: 0 },
  } as unknown as Routes;
  const caller = new Caller({ provider, budget: new Budget(1), routes });
  await assert.rejects(
    caller.embed(EMBED_OPERATION, { text: "x" }, 768),
    (e: unknown) => e instanceof ProviderError && /3 dimensions, not 768/.test(e.message),
  );
});

test("the gateway embeds an image only on a model that embeds images and text in one space", async () => {
  const gateway = new VercelGateway({ apiKey: undefined });
  await assert.rejects(
    gateway.embed({
      model: "openai/text-embedding-3-small",
      input: { image: { mediaType: "image/png", bytes: new Uint8Array([1]) } },
      dimensions: 768,
    }),
    (e: unknown) => e instanceof ProviderError && /embeds text only/.test(e.message),
  );
});
