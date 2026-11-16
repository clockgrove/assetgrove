/**
 * A real check of one masked edit (issue #238, design section 3.4): the OpenAI adapter declares the
 * `mask` capability, so `request-change` sends a mask on its edit route. Run through the product's
 * spend controls under the shared budget of test/real/budget.ts. Skips without OPENAI_API_KEY.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ProviderError } from "../../src/errors.ts";
import { createRaster, decodeImage, encodePng, setPixel } from "../../src/image/raster.ts";
import { OPENAI_DEFAULT_ROUTES, defaultRoutes } from "../../src/routes.ts";
import type { Routes } from "../../src/routes.ts";
import type { LoadedReference } from "../../src/types.ts";
import { realBudget, skipWithout } from "./budget.ts";

const skip = skipWithout("OPENAI_API_KEY");

function png(size: number, inside: (x: number, y: number) => number[]): LoadedReference {
  const raster = createRaster(size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) setPixel(raster, x, y, inside(x, y));
  const bytes = encodePng(raster);
  return {
    role: "reference",
    path: "synthetic",
    mediaType: "image/png",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

test("real request-change: one masked edit on the openai edit route", { skip }, async (t) => {
  const route = OPENAI_DEFAULT_ROUTES["edit"];
  assert.ok(route);
  const share = realBudget().shareUsd;
  const rb = realBudget({
    providers: { openai: { limit: { kind: "key-budget", usd: share } } },
  });
  const configured = rb.provider("openai");
  assert.ok(configured.adapter.capabilities.includes("mask"), "the openai adapter declares mask");
  const routes = { ...defaultRoutes, edit: route } as Routes;
  const { caller } = rb.caller(configured, route.estimatedCostUsd, "real masked edit", routes);
  const size = 256;
  const image = png(size, () => [200, 30, 30, 255]);
  // The region convention: opaque white is the region (the top-left quarter).
  const mask = png(size, (x, y) =>
    x < size / 2 && y < size / 2 ? [255, 255, 255, 255] : [0, 0, 0, 0],
  );
  let edited;
  try {
    edited = await rb.cleared("real masked edit", () =>
      caller.image("edit", "Paint the masked area blue. No text.", [image], undefined, {
        mask: { ...mask, role: "mask" },
      }),
    );
  } catch (error) {
    if (error instanceof ProviderError && (error.status === 403 || error.status === 404)) {
      t.skip(`openai edit unverified (HTTP ${String(error.status)}): ${error.message}`);
      return;
    }
    throw error;
  }
  assert.ok(edited.mediaType.startsWith("image/"));
  assert.ok(decodeImage(edited.bytes).width > 0);
  const record = caller.records[0];
  assert.ok(record);
  assert.deepEqual(record.parameters["mask"], { path: "synthetic", sha256: mask.sha256 });
  assert.equal(record.requestIdSource, "provider", `request ID ${record.requestId}`);
  console.log(`budget left: $${rb.budgetLeftUsd().toFixed(4)}`);
});
