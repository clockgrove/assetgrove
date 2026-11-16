/**
 * The real checks' reconcile of earlier runs (test/real/reconcile.ts), proved offline on the
 * scripted provider with a ledger fixture of old, fresh, pending and mismatched entries.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { digestOf } from "../src/confirm/records.ts";
import type { Script } from "../src/gateway/scripted.ts";
import { defaultRoutes, type Routes } from "../src/routes.ts";
import { withConfirmedSpend } from "./fixtures/clearance.ts";
import { realBudget, WORK_ITEM } from "./real/budget.ts";
import { assertAgreed, reconcileEarlier, reconcileLines, skipReasonOf } from "./real/reconcile.ts";

const temps: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "assetgrove-real-reconcile-test-"));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const PROVIDER = "scripted";
const RUN_START = new Date("2026-11-15T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(RUN_START.getTime() + offsetMs).toISOString();

/** A real-check budget on a fresh ledger directory, with a scripted provider entry. */
function budgetIn(ledgerDir: string) {
  const home = temp();
  return realBudget({
    env: { HOME: home, XDG_STATE_HOME: join(home, "state"), PATH: process.env["PATH"] ?? "" },
    ledgerDir,
    shareUsd: 5,
    providers: { [PROVIDER]: { limit: { kind: "key-budget", usd: 5 } } },
  });
}

interface FixtureCall {
  id: string;
  at: string;
  amountUsd: number;
  costUsd?: number;
  requestId?: string;
  provider?: string;
  workItem?: string;
}

/** Writes `spend.jsonl` lines as the ledger appends them: a reservation, then its settlement. */
function writeLedger(dir: string, calls: FixtureCall[]): void {
  mkdirSync(dir, { recursive: true });
  const lines: unknown[] = [];
  for (const c of calls) {
    lines.push({
      op: "reserve",
      id: c.id,
      at: c.at,
      route: `${c.provider ?? PROVIDER}:still:m`,
      provider: c.provider ?? PROVIDER,
      workItem: c.workItem ?? WORK_ITEM,
      amountUsd: c.amountUsd,
    });
    if (c.costUsd !== undefined)
      lines.push({
        op: "settle",
        id: c.id,
        at: c.at,
        costUsd: c.costUsd,
        ...(c.requestId !== undefined && { requestId: c.requestId }),
      });
  }
  writeFileSync(join(dir, "spend.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
}

/** What the scripted gateway reports now, by request ID: a cost, not yet (undefined) or never (null). */
/** A margin set in this test's settings, to show agreement within the settings' margin. */
const MARGIN_USD = 0.0001;

const reported: Record<string, number | null | undefined> = {
  gen_old_a: 0.02,
  gen_old_b: 0.04 + MARGIN_USD / 2,
  gen_old_c: 0.05,
  gen_recent_d: undefined,
  gen_fresh_e: 0.03,
  gen_other: 9,
};
const IMAGE = { images: [{ mediaType: "image/png", bytes: new Uint8Array([1]) }] };

/** A paid scripted provider whose `callCost` answers as the gateway does. */
function scriptWith(callCost: Script["callCost"], costUsd = 0): Script {
  return {
    paid: true,
    image: () => ({ ...IMAGE, costUsd }),
    vision: () => ({ text: "ok", costUsd }),
    ...(callCost !== undefined && { callCost }),
  };
}

const gateway = scriptWith((id) => (id in reported ? reported[id] : null));

const fixture: FixtureCall[] = [
  // Old entries the gateway has reported: two agree (one within the margin), one does not.
  { id: "old-a", at: at(-3 * HOUR), amountUsd: 0.02, costUsd: 0.02, requestId: "gen_old_a" },
  { id: "old-b", at: at(-2 * HOUR), amountUsd: 0.04, costUsd: 0.04, requestId: "gen_old_b" },
  { id: "old-c", at: at(-2 * HOUR), amountUsd: 0.02, costUsd: 0.02, requestId: "gen_old_c" },
  // An earlier run's entry the gateway has not reported yet.
  { id: "recent-d", at: at(-1000), amountUsd: 0.02, costUsd: 0.02, requestId: "gen_recent_d" },
  // A failed call settled at its estimate (no request ID), and an interrupted, unsettled one.
  { id: "failed-f", at: at(-HOUR), amountUsd: 0.25, costUsd: 0.25 },
  { id: "killed-g", at: at(-HOUR), amountUsd: 0.25 },
  // A reservation a limit refused, cancelled at 0 before any call: not an entry to reconcile.
  { id: "refused-h", at: at(-HOUR), amountUsd: 0.25, costUsd: 0 },
  // This run's own call: not earlier, whatever the gateway says.
  { id: "fresh-e", at: at(1000), amountUsd: 0.03, costUsd: 0.03, requestId: "gen_fresh_e" },
  // Another provider's and another work item's entries are not the gateway's real-check entries.
  {
    id: "other-p",
    at: at(-HOUR),
    amountUsd: 1,
    costUsd: 1,
    requestId: "gen_other",
    provider: "tripo",
  },
  { id: "other-w", at: at(-HOUR), amountUsd: 1, costUsd: 1, requestId: "gen_other", workItem: "x" },
];

test("earlier entries are compared with the gateway: agreed within the margin, pending, mismatched", async () => {
  const dir = join(temp(), "ledger");
  writeLedger(dir, fixture);
  const rb = budgetIn(dir);
  // The real-check settings keep the product's reconcile margin (none): a rounding gap is a mismatch.
  assert.equal(rb.settings.reconcile.marginUsd, undefined);
  const gw = rb.provider(PROVIDER, gateway);
  const strict = await reconcileEarlier(rb, gw.provider.billing, {
    provider: gw.id,
    before: RUN_START,
  });
  assert.equal(strict.entries.find((e) => e.id === "old-b")?.status, "mismatched");
  // Within a margin the settings set, old-b's gap agrees.
  const withMargin = {
    ledger: rb.ledger,
    settings: { reconcile: { ...rb.settings.reconcile, marginUsd: MARGIN_USD } },
  };
  const r = await reconcileEarlier(withMargin, gw.provider.billing, {
    provider: gw.id,
    before: RUN_START,
  });

  assert.deepEqual(
    r.entries.map((e) => [e.id, e.status]),
    [
      ["old-a", "agreed"],
      ["old-b", "agreed"],
      ["old-c", "mismatched"],
      ["recent-d", "pending"],
      ["failed-f", "not-comparable"],
      ["killed-g", "not-comparable"],
    ],
  );
  assert.deepEqual(
    { compared: r.compared, agreed: r.agreed, pending: r.pending, mismatched: r.mismatched },
    { compared: 3, agreed: 2, pending: 1, mismatched: 1 },
  );
  assert.equal(r.notComparable, 2);

  const lines = reconcileLines(r);
  assert.equal(
    lines[0],
    "reconcile (earlier runs, scripted): 3 ledger entries compared with the gateway's usage, " +
      "2 agreed, 1 pending, 1 mismatched; 2 more not comparable",
  );
  const mismatch = lines.find((l) => l.startsWith("mismatch:")) ?? "";
  assert.ok(mismatch.includes("old-c") && mismatch.includes("gen_old_c"), mismatch);
  assert.ok(mismatch.includes("ledger $0.0200 vs gateway $0.0500, gap $0.0300"), mismatch);
  assert.ok(lines.some((l) => l.startsWith("pending:") && l.includes("recent-d")));

  // Something was compared, so the check does not skip: the mismatch fails it, by name.
  assert.equal(skipReasonOf(r), undefined);
  assert.throws(
    () => assertAgreed(r),
    (error: Error) =>
      error.name === "AssertionError" &&
      /1 earlier ledger entry does not agree/.test(error.message) &&
      error.message.includes("old-c") &&
      error.message.includes("gateway $0.0500"),
  );
});

test("with the mismatch gone the check passes; a pending entry never counts as agreeing", async () => {
  const dir = join(temp(), "ledger");
  writeLedger(
    dir,
    fixture.filter((c) => c.id !== "old-c"),
  );
  const rb = budgetIn(dir);
  const gw = rb.provider(PROVIDER, gateway);
  const withMargin = {
    ledger: rb.ledger,
    settings: { reconcile: { ...rb.settings.reconcile, marginUsd: MARGIN_USD } },
  };
  const r = await reconcileEarlier(withMargin, gw.provider.billing, {
    provider: gw.id,
    before: RUN_START,
  });
  assert.deepEqual([r.compared, r.agreed, r.pending, r.mismatched], [2, 2, 1, 0]);
  assert.equal(skipReasonOf(r), undefined);
  assertAgreed(r);
});

test("a first run on an empty cache skips with that reason, and so does one with nothing reported yet", async () => {
  const empty = budgetIn(join(temp(), "ledger"));
  const gw = empty.provider(PROVIDER, gateway);
  const none = await reconcileEarlier(empty, gw.provider.billing, {
    provider: gw.id,
    before: RUN_START,
  });
  assert.equal(none.entries.length, 0);
  assert.match(skipReasonOf(none) ?? "", /first run on an empty cache/);
  assert.match(reconcileLines(none)[0] ?? "", /0 ledger entries compared/);

  // Only this run's own entry: still nothing earlier.
  const freshDir = join(temp(), "ledger");
  writeLedger(
    freshDir,
    fixture.filter((c) => c.id === "fresh-e"),
  );
  const fresh = budgetIn(freshDir);
  const onlyFresh = await reconcileEarlier(
    fresh,
    fresh.provider(PROVIDER, gateway).provider.billing,
    {
      provider: PROVIDER,
      before: RUN_START,
    },
  );
  assert.match(skipReasonOf(onlyFresh) ?? "", /first run on an empty cache/);

  // Earlier entries, but the gateway has reported none of them: pending, skipped, never agreed.
  const pendingDir = join(temp(), "ledger");
  writeLedger(
    pendingDir,
    fixture.filter((c) => c.id === "recent-d" || c.id === "failed-f"),
  );
  const waiting = budgetIn(pendingDir);
  const p = await reconcileEarlier(waiting, waiting.provider(PROVIDER, gateway).provider.billing, {
    provider: PROVIDER,
    before: RUN_START,
  });
  assert.deepEqual([p.compared, p.agreed, p.pending, p.mismatched], [0, 0, 1, 0]);
  assert.equal(
    skipReasonOf(p),
    "none of the 2 earlier scripted ledger entries has a reported cost to compare yet: 1 pending, 1 not comparable",
  );
});

const COST = 0.3;
const routes: Routes = {
  ...defaultRoutes,
  still: { ...defaultRoutes.still, estimatedCostUsd: COST },
};

test("an earlier run's paid call is reconciled by the next run through the request ID its settlement recorded", async () => {
  const ledgerDir = join(temp(), "ledger");
  const configDir = temp();
  const earlier = budgetIn(ledgerDir);
  const script = scriptWith(undefined, COST);
  const request = { command: "real-reconcile-test", inputs: {}, forecastUsd: 0, capUsd: 0 };
  await withConfirmedSpend(
    { kind: "spend", id: digestOf(request), summary: "a test spend", details: {}, body: request },
    {
      settings: {
        configDir,
        stateDir: configDir,
        mode: "headless",
        headless: { operator: "test" },
      },
    },
    async () => {
      const { caller } = earlier.caller(
        earlier.provider(PROVIDER, script),
        COST,
        "earlier run",
        routes,
      );
      await caller.image("still", "a fox", []);
    },
  );
  const [entry] = earlier.ledger.entries();
  assert.ok(entry);
  assert.equal(entry.requestId, "scripted-image-0");

  // Within the run that made it, the call is not earlier: nothing to reconcile yet.
  const sameRun = await reconcileEarlier(
    earlier,
    earlier.provider(
      PROVIDER,
      scriptWith(() => COST),
    ).provider.billing,
    { provider: PROVIDER, before: new Date(Date.parse(entry.at) - 1) },
  );
  assert.ok(skipReasonOf(sameRun));

  // The next run: the gateway has reported the call's cost by now, and it agrees.
  const next = budgetIn(ledgerDir);
  const r = await reconcileEarlier(
    next,
    next.provider(
      PROVIDER,
      scriptWith((id) => (id === "scripted-image-0" ? COST : null)),
    ).provider.billing,
    { provider: PROVIDER, before: new Date(Date.parse(entry.at) + 1) },
  );
  assert.deepEqual([r.compared, r.agreed, r.pending, r.mismatched], [1, 1, 0, 0]);
  assert.equal(skipReasonOf(r), undefined);
  assertAgreed(r);
});
