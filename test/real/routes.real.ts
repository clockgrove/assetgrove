/**
 * Calls each configured core route once through the product, under the shared budget of
 * test/real/budget.ts: the forecast is refused before any call when above the budget left. A route
 * whose adapter is not in this build skips with that reason; OpenAI image and edit skip, with the
 * provider's refusal as the reason, when the key lacks image access.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { IDENTITY_LEVELS } from "../../src/identity.ts";
import { createRaster, encodePng, setPixel } from "../../src/image/raster.ts";
import type { Caller } from "../../src/calls.ts";
import { CORE_ADAPTERS } from "../../src/providers/adapter.ts";
import { ANTHROPIC_DEFAULT_ROUTES } from "../../src/gateway/anthropic.ts";
import { OPENAI_DEFAULT_ROUTES } from "../../src/gateway/openai.ts";
import { defaultRoutes, type Route, type Routes } from "../../src/routes.ts";
import type { LoadedReference } from "../../src/types.ts";
import type { ProviderSettings } from "../../src/settings.ts";
import { legOf, realBudget, SHARES, skipWithout } from "./budget.ts";

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

/** A decision through structured output on a direct adapter's `identity` route. */
const decideRow = (adapter: string, keyEnv: string, route: Route | undefined): Row => ({
  adapter,
  keyEnv,
  name: "decisions",
  ...(route !== undefined && { route }),
  call: async (c) => {
    const { record } = await c.decide(
      "identity",
      "Image 1 is the candidate. Image 2 is the approved reference. Identity record: a plain red disc.",
      [red(), red()],
      {
        type: "score",
        instructions: "How well does image 1 match the identity record?",
        levels: [...IDENTITY_LEVELS],
      },
    );
    return { nonEmpty: record.decision?.decisionSource === "structured-output" };
  },
});

/** The direct routes of design section 20: Anthropic vision and decisions, OpenAI planning and decisions. */
const directRows: Row[] = [
  {
    adapter: "anthropic",
    keyEnv: "ANTHROPIC_API_KEY",
    name: "vision",
    ...(ANTHROPIC_DEFAULT_ROUTES["vision"] && { route: ANTHROPIC_DEFAULT_ROUTES["vision"] }),
    call: async (c) => ({
      nonEmpty:
        (await c.vision("vision", "Describe this image in one short sentence.", [red()])).trim()
          .length > 0,
    }),
  },
  decideRow("anthropic", "ANTHROPIC_API_KEY", ANTHROPIC_DEFAULT_ROUTES["identity"]),
  {
    adapter: "openai",
    keyEnv: "OPENAI_API_KEY",
    name: "planning",
    ...(OPENAI_DEFAULT_ROUTES["compiler"] && { route: OPENAI_DEFAULT_ROUTES["compiler"] }),
    call: async (c) => ({
      nonEmpty:
        (
          await c.vision(
            "compiler",
            "Write a one-line image prompt for a small red apple on a plain background.",
            [],
          )
        ).trim().length > 0,
    }),
  },
  decideRow("openai", "OPENAI_API_KEY", OPENAI_DEFAULT_ROUTES["identity"]),
];

/**
 * OpenAI image and edit: the one accepted skip (design section 20). A key without image access is
 * refused with HTTP 403 (or 404 for a model the key cannot see); the check then skips with the
 * refusal as its reason, and the quick start lists the routes as unverified.
 */
const imageAccessRows: Row[] = [
  {
    adapter: "openai",
    keyEnv: "OPENAI_API_KEY",
    name: "image",
    ...(OPENAI_DEFAULT_ROUTES["still"] && { route: OPENAI_DEFAULT_ROUTES["still"] }),
    call: async (c) => ({
      nonEmpty:
        (await c.image("still", "a small red apple on a plain background", [])).bytes.length > 0,
    }),
  },
  {
    adapter: "openai",
    keyEnv: "OPENAI_API_KEY",
    name: "edit",
    ...(OPENAI_DEFAULT_ROUTES["edit"] && { route: OPENAI_DEFAULT_ROUTES["edit"] }),
    call: async (c) => ({
      nonEmpty: (await c.image("edit", "make the disc blue", [red()])).bytes.length > 0,
    }),
  },
];

/** The routes each adapter's calls are made on: the core table with the adapter's own over it. */
const ROUTES: Record<string, Routes> = {
  "vercel-ai-gateway": defaultRoutes,
  anthropic: { ...defaultRoutes, ...ANTHROPIC_DEFAULT_ROUTES },
  openai: { ...defaultRoutes, ...OPENAI_DEFAULT_ROUTES },
};

/** The direct adapters' declared limits; budget.ts declares the gateway's and Tripo's. */
function directLimits(): Record<string, ProviderSettings> {
  const limit = { kind: "key-budget" as const, usd: SHARES[legOf()] };
  return { anthropic: { limit }, openai: { limit } };
}

/** The provider's refusal when it is a key without image access (HTTP 403 or 404), else undefined. */
function imageAccessRefused(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP (403|404)\b/.test(message) ? message : undefined;
}

for (const row of [...gatewayRows, ...directRows, ...imageAccessRows]) {
  const registered = CORE_ADAPTERS.some((a) => a.id === row.adapter);
  const skip = !registered
    ? `no "${row.adapter}" adapter in this build`
    : !row.call
      ? "no real call written for this route yet"
      : skipWithout(row.keyEnv);
  const title = `real route: ${row.adapter} ${row.name}${row.route ? ` (${row.route.model})` : ""}`;
  test(title, { skip }, async (t) => {
    const { call, route } = row;
    assert.ok(call && route);
    const rb = realBudget({ providers: directLimits() });
    const configured = rb.provider(row.adapter);
    const { caller } = rb.caller(
      configured,
      route.estimatedCostUsd,
      `real route ${row.adapter} ${row.name}`,
      ROUTES[row.adapter],
    );
    let out: { nonEmpty: boolean };
    try {
      out = await call(caller);
    } catch (error) {
      const refused = imageAccessRows.includes(row) ? imageAccessRefused(error) : undefined;
      if (refused === undefined) throw error;
      t.skip(`the OpenAI key lacks image access: ${refused}`);
      return;
    }
    assert.ok(out.nonEmpty, "the route returned something");
    const record = caller.records[0];
    assert.ok(record);
    assert.equal(record.requestIdSource, "provider", `request ID ${record.requestId}`);
    console.log(`budget left: $${rb.budgetLeftUsd().toFixed(4)}`);
  });
}
