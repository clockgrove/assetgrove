/**
 * The pack test kit's conformance suite over the package's entry (#414): it declares the search
 * slot and no kinds, presets or adapters, so the suite checks its shape and ids with the global
 * `fetch` trapped.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertConformance } from "@clockgrove/assetgrove/testing";
import entry from "../src/extension.ts";
import { assertSupportedPlatform } from "../src/platform.ts";

test("the entry passes the conformance suite", async (t) => {
  try {
    assertSupportedPlatform();
  } catch {
    t.skip("the package does not run on this platform");
    return;
  }
  const report = await assertConformance(entry, { name: "search" });
  assert.equal(report.passed, true);
  assert.deepEqual(report.failures, []);
});
