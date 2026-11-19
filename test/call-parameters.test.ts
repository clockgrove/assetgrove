/**
 * Typed per-call parameters (issue #416): size, tiling and a palette file enter the call key and
 * the request digest only when passed, reach a provider that maps them, and are refused before any
 * spend by one that does not.
 */
import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { paletteReads } from "../src/call-parameters.ts";
import type { CallParameters } from "../src/call-parameters.ts";
import { InputError } from "../src/errors.ts";
import type { GenerationProvider, ImageRequest } from "../src/gateway/provider.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { scriptedAdapter, tripoAdapter } from "../src/providers/adapter.ts";
import { RouteUnavailableError } from "../src/routes.ts";
import type { Routes } from "../src/routes.ts";
import { Journal, callKey, withRunScope } from "../src/runs/journal.ts";
import { buildWorkPlan, jobsOf, mergeJobs, requestDigest } from "../src/runs/plan.ts";
import type { PlanJob } from "../src/runs/plan.ts";

const temporary: string[] = [];
after(async () => {
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-call-parameters-")));
  temporary.push(dir);
  return dir;
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const PNG = { mediaType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) };
const ROUTES = {
  sprite: { provider: "p", model: "m", estimatedCostUsd: 0.1 },
} as unknown as Routes;

function scripted(): ScriptedProvider {
  return new ScriptedProvider({ image: () => ({ images: [PNG] }), vision: () => ({ text: "" }) });
}

/** A provider that maps size only, as an adapter with a narrower API would. */
function sizeOnly(): GenerationProvider & { calls: ImageRequest[] } {
  const calls: ImageRequest[] = [];
  const inner = scripted();
  return {
    billing: inner.billing,
    parameters: ["size"],
    calls,
    generateImage: async (request) => {
      calls.push(request);
      return { images: [PNG], requestId: "r" };
    },
    analyzeImages: async () => ({ text: "", requestId: "r" }),
  };
}

function callerOf(provider: GenerationProvider, budget = new Budget(1)): Caller {
  return new Caller({ provider, providerName: "p", budget, routes: ROUTES });
}

function journalKeys(runDir: string): string[] {
  return readdirSync(join(runDir, "calls"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""));
}

const BASE = {
  operation: "image",
  provider: "p",
  model: "m",
  prompt: "x",
  referenceHashes: ["a"],
  seed: 3,
  index: 1,
};

test("a call key with no parameters is byte-identical to the key it always was", () => {
  const before = sha256(
    '{"index":1,"model":"m","operation":"image","prompt":"x","provider":"p","referenceHashes":["a"],"seed":3}',
  );
  assert.equal(callKey(BASE), before);
  assert.equal(callKey({ ...BASE, parameters: undefined }), before);
});

test("size, tiling and the palette each change the call key", () => {
  const keys = [
    callKey(BASE),
    callKey({ ...BASE, parameters: { size: { width: 64, height: 64 } } }),
    callKey({ ...BASE, parameters: { size: { width: 64, height: 32 } } }),
    callKey({ ...BASE, parameters: { tiling: { x: true, y: false } } }),
    callKey({ ...BASE, parameters: { tiling: { x: true, y: true } } }),
    callKey({ ...BASE, parameters: { palette: { path: "a.gpl", sha256: sha256("one") } } }),
    callKey({ ...BASE, parameters: { palette: { path: "a.gpl", sha256: sha256("two") } } }),
    callKey({ ...BASE, parameters: { palette: { path: "b.gpl", sha256: sha256("one") } } }),
  ];
  assert.equal(new Set(keys).size, keys.length);
});

test("the scripted provider receives the parameters, the palette with its bytes, and the journal keys them", async () => {
  const dir = await tempDir();
  mkdirSync(join(dir, ".git"));
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  const paletteBytes = new Uint8Array([1, 2, 3, 4]);
  await writeFile(join(dir, "pal.gpl"), paletteBytes);
  const provider = scripted();
  const parameters: CallParameters = {
    size: { width: 32, height: 16 },
    tiling: { x: true, y: false },
    palette: { path: "pal.gpl", dir },
  };
  const caller = callerOf(provider);
  const runDir = await tempDir();
  await withRunScope({ journal: new Journal(runDir, "r-0000000000000000") }, () =>
    caller.image("sprite", "a gem", [], undefined, { parameters }),
  );
  const [call] = provider.calls;
  assert.equal(call?.kind, "image");
  const request = call?.request as ImageRequest;
  assert.deepEqual(request.output, {
    size: { width: 32, height: 16 },
    tiling: { x: true, y: false },
    palette: { path: "pal.gpl", sha256: sha256(paletteBytes), bytes: paletteBytes },
  });
  const keyed = {
    size: { width: 32, height: 16 },
    tiling: { x: true, y: false },
    palette: { path: "pal.gpl", sha256: sha256(paletteBytes) },
  };
  assert.deepEqual(caller.records[0]?.parameters["callParameters"], keyed);
  assert.deepEqual(journalKeys(runDir), [
    callKey({
      operation: "sprite",
      provider: "p",
      model: "m",
      prompt: "a gem",
      referenceHashes: [],
      parameters: keyed,
    }),
  ]);
});

test("a changed palette file is a new call key", async () => {
  const dir = await tempDir();
  mkdirSync(join(dir, ".git"));
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  const keyOf = async (bytes: string) => {
    await writeFile(join(dir, "pal.gpl"), bytes);
    const runDir = await tempDir();
    await withRunScope({ journal: new Journal(runDir, "r-0000000000000000") }, () =>
      callerOf(scripted()).image("sprite", "a gem", [], undefined, {
        parameters: { palette: { path: "pal.gpl", dir } },
      }),
    );
    return journalKeys(runDir)[0];
  };
  assert.notEqual(await keyOf("one"), await keyOf("two"));
});

test("a call with no parameters changes nothing: no output, no record field, the old key", async () => {
  const provider = scripted();
  const caller = callerOf(provider);
  const runDir = await tempDir();
  await withRunScope({ journal: new Journal(runDir, "r-0000000000000000") }, () =>
    caller.image("sprite", "a gem", []),
  );
  assert.ok(!("output" in (provider.calls[0]?.request as object)));
  assert.ok(!("callParameters" in (caller.records[0]?.parameters ?? {})));
  assert.deepEqual(journalKeys(runDir), [
    callKey({
      operation: "sprite",
      provider: "p",
      model: "m",
      prompt: "a gem",
      referenceHashes: [],
    }),
  ]);
});

test("a palette outside the project is refused before any call", async () => {
  const parent = await tempDir();
  const project = join(parent, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  await writeFile(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(parent, "outside.gpl"), "x");
  const provider = scripted();
  const budget = new Budget(1);
  await assert.rejects(
    callerOf(provider, budget).image("sprite", "a gem", [], undefined, {
      parameters: { palette: { path: "../outside.gpl", dir: project } },
    }),
    (error: unknown) => error instanceof InputError && /palette/.test(error.message),
  );
  assert.equal(provider.calls.length, 0);
  assert.equal(budget.spentUsd + budget.reservedUsd, 0);
});

test("an unreadable palette is an input error naming the file", async () => {
  const dir = await tempDir();
  mkdirSync(join(dir, ".git"));
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  const provider = scripted();
  await assert.rejects(
    callerOf(provider).image("sprite", "a gem", [], undefined, {
      parameters: { palette: { path: "missing.gpl", dir } },
    }),
    (error: unknown) => error instanceof InputError && error.message.includes("missing.gpl"),
  );
  assert.equal(provider.calls.length, 0);
});

test("a parameter its provider does not map is refused before spend, naming it", async () => {
  const provider = sizeOnly();
  const budget = new Budget(1);
  const caller = callerOf(provider, budget);
  await assert.rejects(
    caller.image("sprite", "a gem", [], undefined, {
      parameters: { size: { width: 8, height: 8 }, tiling: { x: true, y: true } },
    }),
    (error: unknown) =>
      error instanceof RouteUnavailableError &&
      error.message.includes("passes tiling") &&
      error.message.includes('provider "p"'),
  );
  assert.equal(provider.calls.length, 0);
  assert.equal(budget.spentUsd + budget.reservedUsd, 0);
  // The one it maps goes through.
  await caller.image("sprite", "a gem", [], undefined, {
    parameters: { size: { width: 8, height: 8 } },
  });
  assert.deepEqual(provider.calls[0]?.output, { size: { width: 8, height: 8 } });
});

test("the scripted adapter declares every parameter and the core real adapters none", () => {
  assert.deepEqual(scriptedAdapter.parameters, ["size", "tiling", "palette"]);
  assert.equal(tripoAdapter.parameters, undefined);
});

test("planned calls put their parameters on the job and in the digest; none leaves the job as it was", () => {
  const routes = { sprite: ROUTES["sprite"]! };
  const call = { operation: "sprite", model: "m", estimatedCostUsd: 0.1 };
  const plain = jobsOf([call], routes);
  assert.ok(!("parameters" in plain[0]!));
  const tiled = jobsOf([{ ...call, parameters: { tiling: { x: true, y: true } } }], routes);
  assert.deepEqual(tiled[0]?.parameters, { tiling: { x: true, y: true } });
  const withPalette = jobsOf(
    [{ ...call, parameters: { palette: { path: "a.gpl", dir: "/ignored" } } }],
    routes,
  );
  assert.deepEqual(withPalette[0]?.parameters, { palette: "a.gpl" });
  assert.equal(jobsOf([{ ...call, parameters: {} }], routes)[0]?.parameters, undefined);
  assert.equal(mergeJobs([...plain, ...tiled]).length, 2, "other parameters do not merge");
  assert.equal(mergeJobs([...tiled, ...tiled])[0]?.count, 2);
  const digest = (jobs: PlanJob[]) =>
    requestDigest({
      command: "x",
      round: 1,
      inputs: {},
      options: {},
      jobs,
      forecastUsd: 0,
      capUsd: 0,
    });
  assert.notEqual(digest(plain), digest(tiled));
  assert.equal(digest(plain), digest(jobsOf([call], routes)));
});

test("a palette's bytes enter the request digest through the plan's reads; one outside the project is refused", async () => {
  const parent = await tempDir();
  const dir = join(parent, "project");
  mkdirSync(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  const calls = [
    {
      operation: "sprite",
      model: "m",
      estimatedCostUsd: 0.1,
      parameters: { palette: { path: "pal.gpl", dir } },
    },
  ];
  assert.deepEqual(paletteReads(calls), { "palette/pal.gpl": join(dir, "pal.gpl") });
  assert.deepEqual(paletteReads([{ operation: "sprite" }]), {});
  const routes = { sprite: ROUTES["sprite"]! };
  const digestOf = async (bytes: string) => {
    await writeFile(join(dir, "pal.gpl"), bytes);
    const plan = await buildWorkPlan(
      { name: "stage", input: { type: "object", properties: {} } } as never,
      {},
      {
        inputs: [],
        reads: paletteReads(calls),
        jobs: jobsOf(calls, routes),
        capUsd: 1,
        paid: false,
        providers: { routes: {}, get: () => undefined },
        candidates: 1,
      },
    );
    return plan.digest;
  };
  const one = await digestOf("one");
  assert.equal(await digestOf("one"), one);
  assert.notEqual(await digestOf("two"), one, "an edited palette is another request");
  await writeFile(join(parent, "outside.gpl"), "x");
  assert.throws(
    () =>
      paletteReads([
        { operation: "sprite", parameters: { palette: { path: "../outside.gpl", dir } } },
      ]),
    (error: unknown) =>
      error instanceof InputError && /palette.*outside the project/.test(error.message),
  );
});
