/**
 * Real checks of the Vercel AI Gateway, run through the product's spend controls under the shared
 * budget of test/real/budget.ts. Skips without AI_GATEWAY_API_KEY.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createRaster, encodePng, setPixel } from "../../src/image/raster.ts";
import { defaultRoutes } from "../../src/routes.ts";
import type { LoadedReference } from "../../src/types.ts";
import { realBudget, skipWithout } from "./budget.ts";

const skip = skipWithout("AI_GATEWAY_API_KEY");

function redSquare(): LoadedReference {
  const raster = createRaster(8, 8);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) setPixel(raster, x, y, [200, 30, 30, 255]);
  const bytes = encodePng(raster);
  return {
    role: "reference",
    path: "synthetic",
    mediaType: "image/png",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

test("real gateway: one image generation", { skip }, async () => {
  const rb = realBudget();
  const gw = rb.provider("vercel-ai-gateway");
  const routes = {
    ...defaultRoutes,
    still: {
      ...defaultRoutes.still,
      model: "bfl/flux-3-image-klein",
      size: "768x768",
      estimatedCostUsd: 0.02,
    },
  };
  const { caller } = rb.caller(gw, 0.02, "real gateway image", routes);
  const image = await rb.cleared("real gateway image", () =>
    caller.image("still", "a small red apple on a plain background", []),
  );
  assert.ok(image.mediaType.startsWith("image/") && image.bytes.length > 0);
  const record = caller.records[0];
  assert.ok(record);
  // The gateway's own request ID and cost reach provenance; a locally generated ID would not count.
  assert.equal(record.requestIdSource, "provider", `request ID ${record.requestId}`);
  assert.ok(!record.requestId.startsWith("local-"));
  assert.equal(record.costSource, "provider", "the gateway reports the call's cost");
  // One reconciled call: the gateway's own cost of the generation, read back by its ID (spends
  // nothing). It may not be reported yet; reconcile then leaves the lookup pending.
  assert.ok(gw.provider.billing.callCost, "the gateway reconciles per call");
  const reported = await gw.provider.billing.callCost(record.requestId);
  assert.notEqual(reported, null, "a generation ID can be looked up");
  if (typeof reported === "number") {
    assert.ok(Number.isFinite(reported) && reported >= 0);
    console.log(`reconciled: ledger $${record.costUsd} vs gateway $${reported}`);
  } else console.log("reconcile: the gateway has not reported the cost yet (pending)");
  console.log(`budget left: $${rb.budgetLeftUsd().toFixed(4)}`);
});

test("real gateway: one vision call", { skip }, async () => {
  const rb = realBudget();
  const gw = rb.provider("vercel-ai-gateway");
  const { caller } = rb.caller(gw, defaultRoutes.vision.estimatedCostUsd, "real gateway vision");
  const text = await rb.cleared("real gateway vision", () =>
    caller.vision("vision", "Describe this image in one short sentence.", [redSquare()]),
  );
  assert.ok(text.trim().length > 0);
  const record = caller.records[0];
  assert.ok(record);
  assert.equal(record.requestIdSource, "provider", `request ID ${record.requestId}`);
  assert.ok(!record.requestId.startsWith("local-"));
  assert.equal(record.costSource, "provider", "the gateway reports the call's cost");
  console.log(`budget left: $${rb.budgetLeftUsd().toFixed(4)}`);
});
