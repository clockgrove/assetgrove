/**
 * Real check of a typed identity decision through the gateway, run through the product's spend
 * controls under the shared budget of test/real/budget.ts. Skips without AI_GATEWAY_API_KEY.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { IDENTITY_LEVELS } from "../../src/identity.ts";
import { createRaster, encodePng, setPixel } from "../../src/image/raster.ts";
import { defaultRoutes } from "../../src/routes.ts";
import type { LoadedReference } from "../../src/types.ts";
import { realBudget, skipWithout } from "./budget.ts";

const skip = skipWithout("AI_GATEWAY_API_KEY");

/** A synthetic 384 px square: a filled circle of one colour on transparency. */
function disc(role: string, rgb: [number, number, number]): LoadedReference {
  const size = 384;
  const r = createRaster(size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if ((x - size / 2) ** 2 + (y - size / 2) ** 2 < (size / 3) ** 2)
        setPixel(r, x, y, [...rgb, 255]);
  const bytes = encodePng(r);
  return {
    role,
    path: "synthetic",
    mediaType: "image/png",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

test(
  "real gateway: one typed identity decision (Score) with reference images",
  { skip },
  async () => {
    const rb = realBudget();
    const gw = rb.provider("vercel-ai-gateway");
    const { caller } = rb.caller(gw, defaultRoutes.identity.estimatedCostUsd, "real identity");
    const { result, record } = await rb.cleared("real identity", () =>
      caller.decide(
        "identity",
        "Image 1 is the candidate. Image 2 is the approved reference. Identity record: a plain red disc.",
        [disc("candidate", [220, 30, 30]), disc("reference", [220, 30, 30])],
        {
          type: "score",
          instructions: "How well does image 1 match the identity record?",
          levels: [...IDENTITY_LEVELS],
        },
      ),
    );
    assert.equal(result.answer.type, "score");
    if (result.answer.type === "score") {
      assert.ok(result.answer.score >= 0 && result.answer.score <= IDENTITY_LEVELS.length - 1);
    }
    assert.equal(record.requestIdSource, "provider", `request ID ${record.requestId}`);
    assert.ok(!record.requestId.startsWith("local-"));
    assert.equal(record.costSource, "provider", "the gateway reports the call's cost");
    console.log(`budget left: $${rb.budgetLeftUsd().toFixed(4)}`);
  },
);
