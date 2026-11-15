/**
 * Calls each configured core route once through the product, under the shared budget of
 * test/real/budget.ts: the forecast is refused before any call when above the budget left. A route
 * whose adapter is not in this build skips with that reason.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { IDENTITY_LEVELS } from "../../src/identity.ts";
import { createRaster, encodePng, setPixel } from "../../src/image/raster.ts";
import type { Caller } from "../../src/calls.ts";
import { CORE_ADAPTERS } from "../../src/providers/adapter.ts";
import { defaultRoutes, type Route } from "../../src/routes.ts";
import type { LoadedReference } from "../../src/types.ts";
import { realBudget, skipWithout } from "./budget.ts";

function disc(role: string, rgb: [number, number, number]): LoadedReference {
  const size = 64;
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

interface Row {
  adapter: string;
  keyEnv: string;
  name: string;
  route?: Route;
  /** The call; returns what came back, which must be non-empty. */
  call?: (caller: Caller) => Promise<{ nonEmpty: boolean }>;
}

const red = () => disc("reference", [220, 30, 30]);

const gatewayRows: Row[] = [
  {
    adapter: "vercel-ai-gateway",
    keyEnv: "AI_GATEWAY_API_KEY",
    name: "still",
    route: defaultRoutes.still,
    call: async (c) => ({
      nonEmpty:
        (await c.image("still", "a small red apple on a plain background", [])).bytes.length > 0,
    }),
  },
  {
    adapter: "vercel-ai-gateway",
    keyEnv: "AI_GATEWAY_API_KEY",
    name: "edit",
    route: defaultRoutes.edit,
    call: async (c) => ({
      nonEmpty: (await c.image("edit", "make the disc blue", [red()])).bytes.length > 0,
    }),
  },
  {
    adapter: "vercel-ai-gateway",
    keyEnv: "AI_GATEWAY_API_KEY",
    name: "vision",
    route: defaultRoutes.vision,
    call: async (c) => ({
      nonEmpty:
        (await c.vision("vision", "Describe this image in one short sentence.", [red()])).trim()
          .length > 0,
    }),
  },
  {
    adapter: "vercel-ai-gateway",
    keyEnv: "AI_GATEWAY_API_KEY",
    name: "identity",
    route: defaultRoutes.identity,
    call: async (c) => {
      const { result } = await c.decide(
        "identity",
        "Image 1 is the candidate. Image 2 is the approved reference. Identity record: a plain red disc.",
        [red(), red()],
        {
          type: "score",
          instructions: "How well does image 1 match the identity record?",
          levels: [...IDENTITY_LEVELS],
        },
      );
      return { nonEmpty: result.answer.type === "score" };
    },
  },
];

/** Core routes of design section 20 whose adapters this build may lack; no call is written yet. */
const absentRows: Row[] = [
  { adapter: "anthropic", keyEnv: "ANTHROPIC_API_KEY", name: "vision" },
  { adapter: "anthropic", keyEnv: "ANTHROPIC_API_KEY", name: "decisions" },
  { adapter: "openai", keyEnv: "OPENAI_API_KEY", name: "planning" },
  { adapter: "openai", keyEnv: "OPENAI_API_KEY", name: "decisions" },
];

for (const row of [...gatewayRows, ...absentRows]) {
  const registered = CORE_ADAPTERS.some((a) => a.id === row.adapter);
  const skip = !registered
    ? `no "${row.adapter}" adapter in this build`
    : !row.call
      ? "no real call written for this route yet"
      : skipWithout(row.keyEnv);
  const title = `real route: ${row.adapter} ${row.name}${row.route ? ` (${row.route.model})` : ""}`;
  test(title, { skip }, async () => {
    const { call, route } = row;
    assert.ok(call && route);
    const rb = realBudget();
    const configured = rb.provider(row.adapter);
    const { caller } = rb.caller(
      configured,
      route.estimatedCostUsd,
      `real route ${row.adapter} ${row.name}`,
    );
    const out = await call(caller);
    assert.ok(out.nonEmpty, "the route returned something");
    const record = caller.records[0];
    assert.ok(record);
    assert.equal(record.requestIdSource, "provider", `request ID ${record.requestId}`);
    console.log(`budget left: $${rb.budgetLeftUsd().toFixed(4)}`);
  });
}
