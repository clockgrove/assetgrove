/**
 * Route provider options in a call's identity (issue #402): they enter the call key and the
 * request digest only where they differ from the default route of the route's own provider, so
 * core's own Tripo and look-dev routes keep the keys they always had.
 */
import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { tripoAdapter } from "../src/providers/adapter.ts";
import { resolveRoute } from "../src/routes.ts";
import type { Route, Routes } from "../src/routes.ts";
import { Journal, callKey, withRunScope } from "../src/runs/journal.ts";
import { jobOf, mergeJobs } from "../src/runs/plan.ts";
import { canonicalJson, requestDigest } from "../src/runs/plan.ts";
import type { LoadedReference } from "../src/types.ts";

const providers = [{ id: "tripo", adapter: tripoAdapter }];
const OPERATION = "model3d";
const PROMPT = "a lantern";

function routeOf(providerOptions?: Record<string, Record<string, unknown>>): Route {
  const routes: Parameters<typeof resolveRoute>[0]["routes"] =
    providerOptions === undefined
      ? {}
      : {
          [OPERATION]: {
            provider: "tripo",
            model: "tripo/v2.5-20250123",
            providerOptions,
          },
        };
  return resolveRoute({ routes, roles: {} }, OPERATION, providers);
}

const changed = { tripo: { modelVersion: "v2.5-20250123", texture: true, pbr: false } };

function view(): LoadedReference & { view: string } {
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  return {
    role: "turnaround",
    path: "front.png",
    mediaType: "image/png",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    view: "front",
  };
}

/** The key as it was before options entered it: exactly the old field set. */
function oldKey(fields: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(fields)).digest("hex");
}

function oldFields(route: Route, reference: LoadedReference) {
  return {
    operation: OPERATION,
    provider: "tripo",
    model: route.model,
    prompt: PROMPT,
    referenceHashes: [reference.sha256],
    occurrence: undefined,
  };
}

function makeProvider(): ScriptedProvider {
  return new ScriptedProvider({
    image: () => ({ images: [] }),
    vision: () => ({ text: "" }),
    model: () => ({ handle: "h", glb: new Uint8Array([1, 2, 3]), costUsd: 0 }),
  });
}

function journalKeys(dir: string): string[] {
  return readdirSync(join(dir, "calls"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""))
    .sort();
}

test("a call on default options keeps today's key", async () => {
  const input = {
    operation: "image",
    provider: "p",
    model: "m",
    prompt: "x",
    referenceHashes: ["a"],
    seed: 3,
    index: 1,
  };
  assert.equal(
    callKey(input),
    oldKey({ ...input, occurrence: undefined }),
    "no options, no new field in the key",
  );

  // Core's own Tripo route carries options, but they are its provider's default: none are keyed.
  const route = routeOf();
  assert.ok(route.providerOptions !== undefined);
  assert.equal(route.keyedProviderOptions, undefined);
  assert.equal(
    routeOf({ ...structuredClone(route.providerOptions) }).keyedProviderOptions,
    undefined,
  );

  const dir = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-route-options-")));
  const reference = view();
  const caller = new Caller({
    provider: makeProvider(),
    providerName: "tripo",
    budget: new Budget(1),
    routes: { [OPERATION]: route } as unknown as Routes,
  });
  await withRunScope({ journal: new Journal(dir, "r-0000000000000000") }, () =>
    caller.model3d(OPERATION, PROMPT, [reference]),
  );
  assert.deepEqual(journalKeys(dir), [oldKey(oldFields(route, reference))]);
});

test("a changed option gets a new key and makes a new call, and is answered from the journal on resume", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-route-options-")));
  const provider = makeProvider();
  const reference = view();
  const reused: boolean[] = [];
  const call = (route: Route) =>
    withRunScope(
      { journal: new Journal(dir, "r-0000000000000000"), onCall: (p) => reused.push(p.reused) },
      () =>
        new Caller({
          provider,
          providerName: "tripo",
          budget: new Budget(1),
          routes: { [OPERATION]: route } as unknown as Routes,
        }).model3d(OPERATION, PROMPT, [reference]),
    );
  const base = routeOf();
  const other = routeOf(changed);
  assert.deepEqual(other.keyedProviderOptions, changed);

  await call(base);
  await call(other);
  assert.equal(provider.calls.length, 2, "the changed option made a new call");
  assert.deepEqual(reused, [false, false]);
  const keys = journalKeys(dir);
  assert.equal(keys.length, 2);
  assert.ok(keys.includes(oldKey(oldFields(base, reference))));
  assert.ok(
    keys.includes(
      callKey({ ...oldFields(other, reference), providerOptions: changed, occurrence: undefined }),
    ),
  );

  await call(other);
  assert.equal(provider.calls.length, 2, "a resume answers the changed call from the journal");
  assert.deepEqual(reused, [false, false, true]);
  assert.equal(journalKeys(dir).length, 2);
});

test("the request digest changes with a route's changed options and not with its default ones", () => {
  const base = routeOf();
  const job = jobOf(OPERATION, base);
  assert.deepEqual(job, {
    operation: OPERATION,
    provider: "tripo",
    model: base.model,
    count: 1,
    estimatedCostUsd: base.estimatedCostUsd,
  });
  const other = jobOf(OPERATION, routeOf(changed));
  assert.deepEqual(other.providerOptions, changed);
  assert.equal(mergeJobs([job, other]).length, 2, "jobs with other options do not merge");
  const digest = (jobs: ReturnType<typeof jobOf>[]) =>
    requestDigest({ command: "x", jobs, inputs: [], options: {} } as unknown as Parameters<
      typeof requestDigest
    >[0]);
  assert.notEqual(digest([job]), digest([other]));
  assert.equal(digest([job]), digest([jobOf(OPERATION, routeOf())]));
});
