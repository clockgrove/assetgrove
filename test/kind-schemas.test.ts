import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { InputError } from "../src/errors.ts";
import { coreExtension } from "../src/extensions/core.ts";
import { checkExtension, ExtensionError } from "../src/extensions/registry.ts";
import type { Generator } from "../src/generators/generator.ts";
import { checkKindSchemas, validateKindProfile, validateKindSpec } from "../src/kind-schemas.ts";
import { planStage } from "../src/loop.ts";
import { validateProfile } from "../src/profile.ts";
import { defaultRoutes } from "../src/routes.ts";
import type { AssetSpec } from "../src/types.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";

function kind(extra: Partial<Generator> = {}): Generator {
  return {
    kind: "pixel:tile",
    planCandidate: () => [],
    generate: () => {
      throw new Error("not called");
    },
    ...extra,
  } as unknown as Generator;
}

const refuse = (why: string) => new InputError(why);
const spec = (fields: unknown): AssetSpec =>
  ({ kind: "pixel:tile", assetId: "t", animationFamily: "idle", fields }) as unknown as AssetSpec;
const specSchema = z.looseObject({ fields: z.object({ tileSize: z.number().int() }) });

test("a spec is checked against its kind's specSchema, naming the field", () => {
  const g = kind({ specSchema });
  assert.throws(
    () => validateKindSpec(g, spec({ tileSize: "big" })),
    (e: unknown) =>
      e instanceof InputError && /pixel:tile spec is invalid: fields\.tileSize/.test(e.message),
  );
  validateKindSpec(g, spec({ tileSize: 16 }));
  validateKindSpec(kind(), spec({ anything: 1 }));
});

test("a profile block is checked against profileSchema, or accepts only values", () => {
  const withSchema = kind({ profileSchema: z.object({ grid: z.number() }) });
  const profile = (block: Record<string, unknown>) =>
    syntheticProfile({ kinds: { "pixel:tile": block } });
  assert.throws(
    () => validateKindProfile(withSchema, profile({ grid: "x" })),
    (e: unknown) => e instanceof InputError && e.message.includes("kinds.pixel:tile.grid"),
  );
  validateKindProfile(withSchema, profile({ grid: 8, values: { a: 1 } }));
  validateKindProfile(withSchema, syntheticProfile());
  assert.throws(
    () => validateKindProfile(kind(), profile({ grid: 8 })),
    (e: unknown) => e instanceof InputError && e.message.includes('unknown field "grid"'),
  );
  validateKindProfile(kind(), profile({ values: { a: 1 } }));
  assert.throws(() => validateKindProfile(kind(), profile({ values: 3 })), InputError);
});

test("checkKindSchemas refuses routing fields at any depth and non-zod schemas", () => {
  assert.throws(
    () => checkKindSchemas(kind({ specSchema: z.object({ model: z.string() }) }), refuse),
    /specSchema of kind pixel:tile declares "model", a routing field/,
  );
  assert.throws(
    () =>
      checkKindSchemas(
        kind({ specSchema: z.object({ fields: z.object({ providerOptions: z.unknown() }) }) }),
        refuse,
      ),
    /declares "fields\.providerOptions"/,
  );
  assert.throws(
    () =>
      checkKindSchemas(
        kind({ profileSchema: z.object({ list: z.array(z.object({ Base_URL: z.string() })) }) }),
        refuse,
      ),
    /profileSchema of kind pixel:tile declares "list\.Base_URL"/,
  );
  assert.throws(
    () => checkKindSchemas(kind({ profileSchema: z.object({ command: z.string() }) }), refuse),
    /declares "command"/,
  );
  assert.throws(
    () => checkKindSchemas(kind({ specSchema: {} as never }), refuse),
    /must be a zod schema/,
  );
  checkKindSchemas(kind({ specSchema, profileSchema: z.object({ grid: z.number() }) }), refuse);
});

test("checkKindSchemas refuses a routing field named by a key enum, const or pattern, or only on the output side", () => {
  const refused = (schema: z.ZodType, field: string) =>
    assert.throws(
      () => checkKindSchemas(kind({ specSchema: schema }), refuse),
      (e: unknown) => e instanceof InputError && e.message.includes(`declares "${field}"`),
      field,
    );
  refused(
    z.object({ fields: z.record(z.enum(["model", "endpoint"]), z.string()) }),
    "fields.model",
  );
  refused(z.record(z.literal("graph"), z.string()), "graph");
  refused(z.record(z.string().regex(/^(command|tile)$/), z.string()), "command");
  refused(z.unknown().pipe(z.object({ model: z.string() })), "model");
  const patterned = { patternProperties: { "^provider": { type: "string" } } };
  refused(z.object({}).meta({ ...patterned }), "provider");
  // A key type that admits any name declares no field, as a loose object does not.
  checkKindSchemas(
    kind({
      specSchema: z.looseObject({ names: z.record(z.string().regex(/^[a-z]+$/), z.number()) }),
      profileSchema: z.record(z.string(), z.number()),
    }),
    refuse,
  );
});

test("the target profile accepts a kinds section", () => {
  const profile = validateProfile(
    { format: "assetgrove-target-profile/1", kinds: { "pixel:tile": { grid: 8 } } },
    "p.json",
  );
  assert.deepEqual(profile.kinds, { "pixel:tile": { grid: 8 } });
});

test("planStage refuses a pack kind that plans an operation it does not declare", () => {
  const call = { operation: "pixel:render", model: "m", estimatedCostUsd: 0.01 };
  const base = { profile: syntheticProfile(), routes: defaultRoutes, spec: spec({ tileSize: 4 }) };
  const undeclared = kind({ planCandidate: () => [call] });
  assert.throws(
    () => planStage({ ...base, generators: [undeclared] }),
    /plans a call on operation "pixel:render", which it does not declare/,
  );
  const declared = kind({ planCandidate: () => [call], operations: { "pixel:render": "still" } });
  assert.equal(planStage({ ...base, generators: [declared] }).calls, 4);
});

test("planStage runs a kind's specSchema and profileSchema before planning, naming the field", () => {
  const routes = defaultRoutes;
  const g = kind({ specSchema, profileSchema: z.object({ grid: z.number() }) });
  assert.throws(
    () =>
      planStage({
        spec: spec({ tileSize: "big" }),
        profile: syntheticProfile(),
        routes,
        generators: [g],
      }),
    (e: unknown) => e instanceof InputError && /fields\.tileSize/.test(e.message),
  );
  assert.throws(
    () =>
      planStage({
        spec: spec({ tileSize: 4 }),
        profile: syntheticProfile({ kinds: { "pixel:tile": { grid: "x" } } }),
        routes,
        generators: [g],
      }),
    (e: unknown) => e instanceof InputError && e.message.includes("kinds.pixel:tile.grid"),
  );
  planStage({
    spec: spec({ tileSize: 4 }),
    profile: syntheticProfile({ kinds: { "pixel:tile": { grid: 8 } } }),
    routes,
    generators: [g],
  });
});

test("at load, a pack kind whose schema declares a model field is refused; core's kinds pass the same check", () => {
  const extension = {
    api: 2,
    name: "pixel",
    kinds: [kind({ specSchema: z.looseObject({ fields: z.object({ model: z.string() }) }) })],
  };
  assert.throws(
    () => checkExtension(extension, "extensions[0]"),
    (error: unknown) =>
      error instanceof ExtensionError &&
      error.code === "extension_refused" &&
      /declares "fields\.model", a routing field/.test(error.message),
  );
  for (const core of coreExtension.kinds ?? []) {
    assert.ok(core.specSchema !== undefined && core.profileSchema !== undefined, core.kind);
    checkKindSchemas(core, refuse);
  }
});
