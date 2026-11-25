/**
 * The test kit's conformance suite over the pack's entry as it ships: the kind's two operations
 * take their roles' default routes (`image`, `decisions`), as core routes them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertConformance, sampleProfile, sampleScript } from "@clockgrove/assetgrove/testing";
import entry from "../src/extension.ts";

test("the entry passes the conformance suite", async () => {
  const report = await assertConformance(entry, {
    kinds: {
      "tiles:terrain": {
        spec: {
          kind: "tiles:terrain",
          assetId: "grass-dirt",
          fields: { terrains: { lower: "dirt", upper: "grass" } },
        },
        profile: sampleProfile({ kinds: { "tiles:terrain": { tileSize: 16 } } }),
        script: {
          ...sampleScript(),
          decide: () => ({ answer: { type: "boolean", probability: 0.9 } }),
        },
      },
    },
  });
  assert.equal(report.passed, true);
  assert.deepEqual(report.failures, []);
});
