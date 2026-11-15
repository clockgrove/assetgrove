/**
 * Calls each configured core route once through the product, under the shared budget of
 * test/real/budget.ts: the forecast is refused before any call when above the budget left. A route
 * whose adapter is not in this build skips with that reason, and so does a route whose key is unset.
 * The direct routes (design section 20): Anthropic vision and decisions, OpenAI planning and
 * decisions, and OpenAI image and edit, which skip with the provider's reason when the key lacks
 * image access (the one accepted skip).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { IDENTITY_LEVELS } from "../../src/identity.ts";
import { createRaster, encodePng, setPixel } from "../../src/image/raster.ts";
import type { Caller } from "../../src/calls.ts";
import { CORE_ADAPTERS } from "../../src/providers/adapter.ts";
import {
  ANTHROPIC_DEFAULT_ROUTES,
  defaultRoutes,
  OPENAI_DEFAULT_ROUTES,
  type Route,
  type Routes,
} from "../../src/routes.ts";
import type { LoadedReference } from "../../src/types.ts";
import { ProviderError } from "../../src/errors.ts";
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
  /** The operation the call routes, when it is not `name`. */
  operation?: string;
  /** The call; returns what came back, which must be non-empty. */
  call?: (caller: Caller) => Promise<{ nonEmpty: boolean }>;
  /** A provider refusal that skips the check, with its reason, instead of failing it. */
  skipOn?: (error: ProviderError) => boolean;
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

const identityCall = async (c: Caller) => {
  const { result, record } = await c.decide(
    "identity",
    "Image 1 is the candidate. Image 2 is the approved reference. Identity record: a plain red disc.",
    [red(), red()],
    {
      type: "score",
      instructions: "How well does image 1 match the identity record?",
      levels: [...IDENTITY_LEVELS],
    },
  );
  return {
    nonEmpty: result.answer.type === "score" && record.decision?.decisionSource !== undefined,
  };
};

const visionCall = async (c: Caller) => ({
  nonEmpty:
    (await c.vision("vision", "Describe this image in one short sentence.", [red()])).trim()
      .length > 0,
});

const planningCall = async (c: Caller) => ({
  nonEmpty:
    (
      await c.vision(
        "compiler",
        'Write a one-line image prompt for a red disc on a plain background. Answer as JSON: {"prompt": "..."}.',
        [red()],
      )
    ).trim().length > 0,
});

/**
 * An OpenAI key without image access is the one accepted skip (design section 20). It is read from
 * the provider's structured answer, never its message: HTTP 403 (the key's organization may not use
 * the image model) or the provider code `model_not_found` (the model is not available to the key).
 */
const NO_IMAGE_ACCESS = (error: ProviderError): boolean =>
  error.status === 403 || error.providerCode === "model_not_found";

/** The direct routes of design section 20. */
const directRows: Row[] = [
  {
    adapter: "anthropic",
    keyEnv: "ANTHROPIC_API_KEY",
    name: "vision",
    route: ANTHROPIC_DEFAULT_ROUTES["vision"],
    call: visionCall,
  },
  {
    adapter: "anthropic",
    keyEnv: "ANTHROPIC_API_KEY",
    name: "decisions",
    operation: "identity",
    route: ANTHROPIC_DEFAULT_ROUTES["identity"],
    call: identityCall,
  },
  {
    adapter: "openai",
    keyEnv: "OPENAI_API_KEY",
    name: "planning",
    operation: "compiler",
    route: OPENAI_DEFAULT_ROUTES["compiler"],
    call: planningCall,
  },
  {
    adapter: "openai",
    keyEnv: "OPENAI_API_KEY",
    name: "decisions",
    operation: "identity",
    route: OPENAI_DEFAULT_ROUTES["identity"],
    call: identityCall,
  },
  {
    adapter: "openai",
    keyEnv: "OPENAI_API_KEY",
    name: "image",
    operation: "still",
    route: OPENAI_DEFAULT_ROUTES["still"],
    call: async (c) => ({
      nonEmpty:
        (await c.image("still", "a small red apple on a plain background", [])).bytes.length > 0,
    }),
    skipOn: NO_IMAGE_ACCESS,
  },
  {
    adapter: "openai",
    keyEnv: "OPENAI_API_KEY",
    name: "edit",
    route: OPENAI_DEFAULT_ROUTES["edit"],
    call: async (c) => ({
      nonEmpty: (await c.image("edit", "make the disc blue", [red()])).bytes.length > 0,
    }),
    skipOn: NO_IMAGE_ACCESS,
  },
];

/** The declared limit of the direct providers, as budget.ts declares the others'. */
const directProviders = (shareUsd: number) => ({
  anthropic: { limit: { kind: "key-budget" as const, usd: shareUsd } },
  openai: { limit: { kind: "key-budget" as const, usd: shareUsd } },
});

for (const row of [...gatewayRows, ...directRows]) {
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
    const share = realBudget().shareUsd;
    const rb = realBudget({ providers: directProviders(share) });
    const configured = rb.provider(row.adapter);
    const operation = row.operation ?? row.name;
    const routes = { ...defaultRoutes, [operation]: route } as Routes;
    const { caller } = rb.caller(
      configured,
      route.estimatedCostUsd,
      `real route ${row.adapter} ${row.name}`,
      routes,
    );
    let out: { nonEmpty: boolean };
    try {
      out = await call(caller);
    } catch (error) {
      if (row.skipOn && error instanceof ProviderError && row.skipOn(error)) {
        const facts = `HTTP ${String(error.status)}, code ${error.providerCode ?? "none"}`;
        t.skip(`${row.adapter} ${row.name} unverified (${facts}): ${error.message}`);
        return;
      }
      throw error;
    }
    assert.ok(out.nonEmpty, "the route returned something");
    const record = caller.records[0];
    assert.ok(record);
    assert.equal(record.requestIdSource, "provider", `request ID ${record.requestId}`);
    console.log(`budget left: $${rb.budgetLeftUsd().toFixed(4)}`);
  });
}
