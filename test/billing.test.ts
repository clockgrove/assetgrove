/**
 * Billing (issue #404): where a call's cost comes from (`settle`) and whether it can be looked up
 * later (`reconcile`) are separate; `paid` is core's; a settle above the route's estimate holds;
 * a provider's own `estimate` may only lower a reservation.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Budget, BudgetExceededError, EstimateAboveCeilingError } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { errorOutcome } from "../src/commands/runner.ts";
import type { Billing, GenerationProvider } from "../src/gateway/provider.ts";
import type { Script } from "../src/gateway/scripted.ts";
import { CORE_ADAPTERS, corePaid, createProvider } from "../src/providers/adapter.ts";
import type { ProviderAdapter } from "../src/providers/adapter.ts";
import { finishRunReconcile } from "../src/reconcile.ts";
import type { Routes } from "../src/routes.ts";
import { Journal, withRunScope } from "../src/runs/journal.ts";
import type { Clearance } from "../src/runs/journal.ts";
import { HOLDS_FILE, SpendLedger, assertNoOpenHold, readHolds } from "../src/spend.ts";

const RUN_ID = "r-00000000000000b1";
const CEILING = 0.05;
const ROUTE = "scripted:still:m-1";
const clearance = { digest: "d", record: {} } as unknown as Clearance;
const PNG = { mediaType: "image/png", bytes: new Uint8Array([1]) };
const temporary: string[] = [];
after(async () => {
  for (const dir of temporary) await rm(dir, { recursive: true, force: true });
});

/** A paid scripted provider's script: settles and reconciles as given, reports `costUsd`. */
function paidScript(over: Partial<Script> & { costUsd?: number } = {}): Script & {
  images: number;
  estimates: number;
} {
  const { costUsd, ...rest } = over;
  const script = {
    images: 0,
    estimates: 0,
    paid: true,
    image() {
      script.images++;
      return { images: [PNG], ...(costUsd !== undefined && { costUsd }) };
    },
    vision() {
      return { text: "" };
    },
    ...rest,
  };
  return script;
}

/** A state directory and run directory, the settings reconcile reads, and the run's ledger. */
async function world() {
  const stateDir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-billing-")));
  temporary.push(stateDir);
  const runDir = join(stateDir, "runs", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  const settings = {
    stateDir,
    caps: { runUsd: 10, dailyUsd: 100, workItemUsd: 100 },
    reconcile: {},
    spend: { acknowledgedHolds: [] as string[] },
  };
  return { stateDir, runDir, settings, ledger: SpendLedger.fromSettings(settings, { env: {} }) };
}

/** One paid `still` call on the scripted adapter inside a confirmed run. */
async function still(script: Script, w: Awaited<ReturnType<typeof world>>, log?: string[]) {
  const configured = createProvider(
    "scripted",
    { limit: { kind: "prepaid", usd: 100 } },
    { script },
  );
  const routes = {
    still: { provider: "scripted", model: "m-1", estimatedCostUsd: CEILING },
  } as unknown as Routes;
  const caller = new Caller({
    provider: configured.provider,
    providerName: "scripted",
    budget: new Budget(5, w.ledger),
    routes,
    ...(log !== undefined && { log: (line: string) => log.push(line) }),
  });
  await withRunScope({ journal: new Journal(w.runDir, RUN_ID), clearance }, () =>
    caller.image("still", "a lantern", []),
  );
  return { configured, record: caller.records[0]! };
}

test("each settle and reconcile pairing settles and reconciles as declared", async () => {
  const cases = [
    // The reported cost is settled and compared with the looked-up cost.
    {
      settle: "reported",
      reconcile: "lookup",
      cost: 0.02,
      source: "provider",
      status: "reconciled",
    },
    // The reported cost is settled; nothing can be looked up.
    {
      settle: "reported",
      reconcile: "unavailable",
      cost: 0.02,
      source: "provider",
      status: "unavailable",
    },
    // The estimate is settled; the lookup settles it to the provider's cost, compared on neither side.
    {
      settle: "declared",
      reconcile: "lookup",
      cost: CEILING,
      source: "estimate",
      status: "reconciled",
      settledTo: 0.02,
    },
    // The estimate is settled and stays.
    {
      settle: "declared",
      reconcile: "unavailable",
      cost: CEILING,
      source: "estimate",
      status: "unavailable",
    },
  ] as const;
  for (const c of cases) {
    const what = `${c.settle}/${c.reconcile}`;
    const w = await world();
    const script = paidScript({
      settle: c.settle,
      reconcile: c.reconcile,
      costUsd: 0.02,
      ...(c.reconcile === "lookup" && { callCost: () => 0.02 }),
    });
    const { configured, record } = await still(script, w);
    assert.equal(configured.provider.billing.settle, c.settle, what);
    assert.equal(configured.provider.billing.reconcile, c.reconcile, what);
    assert.equal(record.costUsd, c.cost, what);
    assert.equal(record.costSource, c.source, what);
    const [call] = w.ledger.entries();
    assert.equal(call?.amountUsd, CEILING, `${what}: reserves the route's estimate`);
    assert.equal(call?.costUsd, c.cost, `${what}: settles as declared`);

    const [entry] = await finishRunReconcile(
      { settings: w.settings, providers: [configured] },
      { runId: RUN_ID, runDir: w.runDir, providers: ["scripted"] },
    );
    assert.equal(entry?.status, c.status, what);
    if ("settledTo" in c) {
      assert.equal(entry?.settled, 1, `${what}: the estimate is settled to the looked-up cost`);
      assert.equal(w.ledger.runCalls(RUN_ID)[0]?.costUsd, c.settledTo, what);
    }
    assert.equal(existsSync(join(w.stateDir, HOLDS_FILE)), false, `${what}: no hold`);
  }
});

test("every core adapter declares settle and reconcile", () => {
  const expected: Record<string, [Billing["settle"], Billing["reconcile"]]> = {
    "vercel-ai-gateway": ["reported", "lookup"],
    anthropic: ["declared", "unavailable"],
    openai: ["declared", "unavailable"],
    tripo: ["reported", "lookup"],
    "openai-compatible": ["declared", "unavailable"],
    scripted: ["reported", "unavailable"],
  };
  assert.deepEqual(CORE_ADAPTERS.map((a) => a.id).sort(), Object.keys(expected).sort());
  for (const adapter of CORE_ADAPTERS) {
    const entry =
      adapter.id === "openai-compatible"
        ? { adapter: adapter.id, baseURL: "https://models.example.test/v1" }
        : { adapter: adapter.id };
    const { provider } = createProvider(`p-${adapter.id}`, entry, { env: {} });
    const { settle, reconcile, callCost } = provider.billing;
    assert.deepEqual([settle, reconcile], expected[adapter.id], adapter.id);
    assert.equal(callCost !== undefined, reconcile === "lookup", `${adapter.id}: callCost`);
  }
});

/** A pack's adapter that declares its provider free, on a fixed host or one from settings. */
function freePack(endpointFromSettings: boolean): ProviderAdapter {
  const billing = (providerId: string): Billing => ({
    adapter: "pack:free",
    providerId,
    paid: false,
    hosts: ["api.pack.example.test"],
    settle: "declared",
    reconcile: "unavailable",
  });
  return {
    id: "pack:free",
    capabilities: ["image"],
    fixedHosts: ["api.pack.example.test"],
    endpointFromSettings,
    create: (c): GenerationProvider & { parts: Billing[] } => ({
      billing: billing(c.providerId),
      parts: [billing(c.providerId)],
      billingFor: () => billing(c.providerId),
      generateImage: () => Promise.reject(new Error("not called")),
      analyzeImages: () => Promise.reject(new Error("not called")),
    }),
  };
}

test("a pack that claims free is paid unless settings say free on a loopback endpoint", () => {
  const fixed = createProvider("p", { adapter: "pack:free" }, { adapters: [freePack(false)] });
  assert.equal(fixed.provider.billing.paid, true, "a fixed host is paid");
  assert.equal(fixed.provider.billingFor?.("image").paid, true, "each kind's billing too");
  const parts = (fixed.provider as unknown as { parts: Billing[] }).parts;
  assert.deepEqual(
    parts.map((b) => b.paid),
    [true],
    "and each part",
  );

  const remote = createProvider(
    "p",
    { adapter: "pack:free", baseURL: "https://api.pack.example.test/v1", free: true },
    { adapters: [freePack(true)] },
  );
  assert.equal(remote.provider.billing.paid, true, "free on a non-loopback host is still paid");

  const local = createProvider(
    "p",
    { adapter: "pack:free", baseURL: "http://127.0.0.1:8080/v1", free: true },
    { adapters: [freePack(true)] },
  );
  assert.equal(local.provider.billing.paid, false, "free on a loopback host");
  assert.equal(local.provider.billingFor?.("image").paid, false);

  const unmarked = createProvider(
    "p",
    { adapter: "pack:free", baseURL: "http://localhost:8080/v1" },
    { adapters: [freePack(true)] },
  );
  assert.equal(unmarked.provider.billing.paid, true, "loopback without free is paid");

  assert.equal(corePaid({ free: true, baseURL: "http://[::1]:8080/" }), false);
  assert.equal(corePaid({ free: true, baseURL: "http://127.0.0.1.example.test/" }), true);
  assert.equal(corePaid({ free: true }), true, "free with no endpoint is paid");
});

test("a settle above the route's estimate appends a spend hold; at or under it, none", async () => {
  for (const cost of [0.01, CEILING]) {
    const w = await world();
    const { record } = await still(paidScript({ costUsd: cost }), w);
    assert.equal(record.costUsd, cost);
    assert.equal(existsSync(join(w.stateDir, HOLDS_FILE)), false, `$${cost} settles normally`);
  }

  const w = await world();
  const log: string[] = [];
  const { record } = await still(paidScript({ costUsd: 0.08 }), w, log);
  assert.equal(record.costUsd, 0.08, "the call settles at what it cost");
  assert.equal(w.ledger.runCalls(RUN_ID)[0]?.costUsd, 0.08);
  const holds = readHolds(w.stateDir);
  assert.equal(holds.length, 1);
  const [hold] = holds;
  assert.equal(hold?.reason, "settle-above-ceiling");
  assert.equal(hold?.route, ROUTE);
  assert.equal(hold?.provider, "scripted");
  assert.equal(hold?.runId, RUN_ID);
  assert.equal(hold?.ledgerUsd, CEILING);
  assert.equal(hold?.providerUsd, 0.08);
  assert.ok(Math.abs((hold?.gapUsd ?? 0) - 0.03) < 1e-9);
  assert.match(log.join("\n"), new RegExp(`spend hold ${hold?.id}`));
  // As a reconcile mismatch does: every later paid run is refused until a person acknowledges it.
  assert.throws(() => assertNoOpenHold(w.settings), /spend hold/);
  assertNoOpenHold({ ...w.settings, spend: { acknowledgedHolds: [hold!.id] } });
  assert.ok(readFileSync(join(w.stateDir, HOLDS_FILE), "utf8").includes(ROUTE));
});

test("a free call above its route's estimate holds nothing", async () => {
  const w = await world();
  const script = paidScript({ costUsd: 0.08 });
  delete script.paid;
  const { configured } = await still(script, w);
  assert.equal(configured.provider.billing.paid, false);
  assert.equal(existsSync(join(w.stateDir, HOLDS_FILE)), false);
});

test("an estimate under the ceiling lowers the reservation; declared settles at it", async () => {
  const w = await world();
  const script = paidScript({
    settle: "declared",
    estimate: (request, kind) => {
      script.estimates++;
      assert.equal(kind, "image");
      assert.equal((request as { prompt: string }).prompt, "a lantern");
      return 0.01;
    },
  });
  const { record } = await still(script, w);
  assert.equal(script.estimates, 1);
  const [call] = w.ledger.entries();
  assert.equal(call?.amountUsd, 0.01, "reserves the lower of the estimate and the ceiling");
  assert.equal(call?.costUsd, 0.01);
  assert.equal(record.costUsd, 0.01);
});

test("an estimate above the ceiling refuses the call before spend, naming the route", async () => {
  const w = await world();
  const script = paidScript({
    estimate: () => {
      script.estimates++;
      return 0.09;
    },
  });
  const error = await still(script, w).then(
    () => assert.fail("the call was made"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof EstimateAboveCeilingError);
  assert.ok(error instanceof BudgetExceededError);
  assert.equal(error.route, ROUTE);
  assert.match(error.message, new RegExp(`route ${ROUTE}`));
  assert.match(error.message, /routes\.still\.estimatedCostUsd/);
  assert.equal(errorOutcome(error).exitCode, 3);
  assert.equal(script.images, 0, "the provider was not called");
  assert.deepEqual(w.ledger.runCalls(RUN_ID), [], "nothing was reserved");
});

test("the estimate is asked only after the spend is confirmed", async () => {
  const w = await world();
  const script = paidScript({
    estimate: () => {
      script.estimates++;
      return 0.01;
    },
  });
  const configured = createProvider(
    "scripted",
    { limit: { kind: "prepaid", usd: 100 } },
    { script },
  );
  const caller = new Caller({
    provider: configured.provider,
    providerName: "scripted",
    budget: new Budget(5, w.ledger),
    routes: {
      still: { provider: "scripted", model: "m-1", estimatedCostUsd: CEILING },
    } as unknown as Routes,
  });
  await assert.rejects(
    withRunScope({ journal: new Journal(w.runDir, RUN_ID) }, () =>
      caller.image("still", "a lantern", []),
    ),
    /no confirmed spend/,
  );
  assert.equal(script.estimates, 0);
});
