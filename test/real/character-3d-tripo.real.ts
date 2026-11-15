/**
 * Opt-in check of the Tripo credentials, under the shared budget of test/real/budget.ts. Set
 * TRIPO_API_KEY. It only reads the account balance, so it spends nothing. Without a key it skips.
 * Run with `pnpm test:real`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TripoProvider } from "../../src/gateway/tripo.ts";
import { realBudget, skipWithout } from "./budget.ts";

const skip = skipWithout("TRIPO_API_KEY");

test("tripo accepts the key and reports a balance", { skip }, async () => {
  const rb = realBudget();
  const tripo = rb.provider("tripo");
  const balance = await (tripo.provider as TripoProvider).balance();
  assert.equal(typeof balance, "number");
});
