/**
 * Real check of hosted search embeddings (issue #242, design section 7.7): a few images and one
 * query embedded through the gateway's embeddings route, `google/gemini-embedding-2`, which puts
 * images and text in one space, under the shared budget of test/real/budget.ts. Every call goes
 * through `Caller.embed`, so each is reserved against the run cap and the ledger. Skips without
 * AI_GATEWAY_API_KEY.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createRaster, encodePng, setPixel } from "../../src/image/raster.ts";
import { EMBED_OPERATION } from "../../src/routes.ts";
import type { Routes } from "../../src/routes.ts";
import type { LoadedReference } from "../../src/types.ts";
import { realBudget, skipWithout } from "./budget.ts";

const skip = skipWithout("AI_GATEWAY_API_KEY");

/** The width the search index stores (design section 7.3). */
const DIMENSION = 768;
/** An upper estimate of one embedding: about 260 image tokens at $0.20 per million is $0.0001. */
const ESTIMATE_USD = 0.001;

function square(name: string, rgb: [number, number, number]): LoadedReference {
  const raster = createRaster(32, 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) setPixel(raster, x, y, [...rgb, 255]);
  const bytes = encodePng(raster);
  return {
    role: "search",
    path: name,
    mediaType: "image/png",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / Math.sqrt(na * nb);
}

test("real gateway: a few images and one query embedded in one space", { skip }, async () => {
  const rb = realBudget();
  const gw = rb.provider("vercel-ai-gateway");
  const routes = {
    [EMBED_OPERATION]: {
      provider: gw.id,
      model: "google/gemini-embedding-2",
      estimatedCostUsd: ESTIMATE_USD,
    },
  } as unknown as Routes;
  const images = [
    square("red", [220, 20, 20]),
    square("green", [20, 200, 40]),
    square("blue", [20, 40, 220]),
  ];
  const { caller } = rb.caller(gw, ESTIMATE_USD * (images.length + 1), "real embeddings", routes);
  const { vectors, query } = await rb.cleared("real embeddings", async () => ({
    vectors: await Promise.all(
      images.map((image) => caller.embed(EMBED_OPERATION, { image }, DIMENSION)),
    ),
    query: await caller.embed(EMBED_OPERATION, { text: "a plain red square" }, DIMENSION),
  }));
  for (const v of [...vectors, query]) assert.equal(v.length, DIMENSION);
  const scores = vectors.map((v) => cosine(v, query));
  console.log(`similarity to "a plain red square": ${scores.map((s) => s.toFixed(3)).join(", ")}`);
  assert.equal(scores.indexOf(Math.max(...scores)), 0, "the query lands nearest the red image");
  assert.equal(caller.records.length, images.length + 1);
  for (const record of caller.records) {
    assert.equal(record.operation, EMBED_OPERATION);
    assert.equal(record.requestIdSource, "provider", `request ID ${record.requestId}`);
    assert.ok(record.costUsd <= ESTIMATE_USD, `cost ${record.costUsd}`);
  }
  console.log(`budget left: $${rb.budgetLeftUsd().toFixed(4)}`);
});
