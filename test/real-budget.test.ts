import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import ts from "typescript";
import { BudgetExceededError } from "../src/budget.ts";
import { digestOf } from "../src/confirm/records.ts";
import { withConfirmedSpend } from "./fixtures/clearance.ts";
import { ScriptedProvider, type Script } from "../src/gateway/scripted.ts";
import { defaultRoutes, type Routes } from "../src/routes.ts";
import {
  ledgerDirOf,
  legOf,
  realBudget,
  RUN_USD,
  SHARES,
  TOTAL_USD,
  WORK_ITEM,
} from "./real/budget.ts";

const temps: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "assetgrove-real-budget-test-"));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const COST = 0.3;
const PNG = new Uint8Array([1]);
const script: Script = {
  paid: true,
  image: () => ({ images: [{ mediaType: "image/png", bytes: PNG }], costUsd: COST }),
  vision: () => ({ text: "ok", costUsd: COST }),
};
const routes: Routes = {
  ...defaultRoutes,
  still: { ...defaultRoutes.still, estimatedCostUsd: COST },
};

function syntheticEnv(home: string): Record<string, string> {
  return { HOME: home, XDG_STATE_HOME: join(home, "state"), PATH: process.env["PATH"] ?? "" };
}

const scriptedOf = (p: { provider: unknown }): ScriptedProvider => {
  assert.ok(p.provider instanceof ScriptedProvider);
  return p.provider;
};

/** Runs `body` with a headless spend confirmation recorded in a temporary config directory. */
function cleared<T>(body: () => Promise<T>): Promise<T> {
  const dir = temp();
  const request = { command: "real-budget-test", inputs: {}, forecastUsd: 0, capUsd: 0 };
  return withConfirmedSpend(
    { kind: "spend", id: digestOf(request), summary: "a test spend", details: {}, body: request },
    {
      settings: { configDir: dir, stateDir: dir, mode: "headless", headless: { operator: "test" } },
    },
    body,
  );
}

test("the budget constants and settings hold the design's numbers", () => {
  assert.equal(TOTAL_USD, 25);
  assert.equal(SHARES.ci + SHARES.local + SHARES.reserve, TOTAL_USD);
  assert.equal(RUN_USD, 1.5);

  const home = temp();
  const ledgerDir = join(home, "ledger");
  const rb = realBudget({ env: syntheticEnv(home), ledgerDir, shareUsd: 3 });
  assert.equal(rb.settings.caps.runUsd, 1.5);
  assert.equal(rb.settings.caps.workItemUsd, 3);
  assert.equal(rb.settings.stateDir, ledgerDir);

  assert.equal(legOf({ CI: "true" }), "ci");
  assert.equal(legOf({}), "local");
  assert.equal(ledgerDirOf({ ASSETGROVE_REAL_LEDGER: "/some/ledger" }), "/some/ledger");
});

test("spend accumulates across runs sharing a ledger directory and an over-budget forecast refuses before any call", () =>
  cleared(async () => {
    const home = temp();
    const env = syntheticEnv(home);
    const ledgerDir = join(home, "ledger");
    const options = {
      env,
      ledgerDir,
      shareUsd: 1,
      providers: { scripted: { limit: { kind: "key-budget", usd: 1 } } },
    } as const;

    const rb1 = realBudget(options);
    assert.equal(rb1.budgetLeftUsd(), 1);
    const p1 = rb1.provider("scripted", script);
    const run1 = rb1.caller(p1, 0.25, "run 1", routes);
    await run1.caller.image("still", "a fox", []);
    assert.equal(scriptedOf(p1).calls.length, 1);
    assert.ok(Math.abs(rb1.budgetLeftUsd() - (1 - COST)) < 1e-9);

    const rb2 = realBudget(options);
    assert.ok(Math.abs(rb2.budgetLeftUsd() - (1 - COST)) < 1e-9, "run 2 sees run 1's spend");
    const entries = readFileSync(join(ledgerDir, "spend.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { op: string; workItem?: string });
    const reserves = entries.filter((e) => e.op === "reserve");
    assert.ok(reserves.length > 0);
    assert.ok(reserves.every((e) => e.workItem === WORK_ITEM));

    const p2 = rb2.provider("scripted", script);
    const run2 = rb2.caller(p2, 0.25, "run 2", routes);
    await run2.caller.image("still", "a fox", []);
    assert.ok(Math.abs(rb2.budgetLeftUsd() - (1 - 2 * COST)) < 1e-9, "spend accumulated");

    const before = scriptedOf(p2).calls.length;
    assert.throws(() => rb2.caller(p2, 0.5, "too much", routes), BudgetExceededError);
    assert.equal(scriptedOf(p2).calls.length, before, "no provider call was made");
  }));

test("a forecast above the run cap refuses even when the budget left is larger", () => {
  const home = temp();
  const rb = realBudget({
    env: syntheticEnv(home),
    ledgerDir: join(home, "ledger"),
    shareUsd: 10,
    providers: { scripted: { limit: { kind: "key-budget", usd: 10 } } },
  });
  const p = rb.provider("scripted", script);
  assert.equal(rb.budgetLeftUsd(), 10);
  assert.throws(() => rb.caller(p, RUN_USD + 0.1, "over the run cap", routes), BudgetExceededError);
  assert.equal(scriptedOf(p).calls.length, 0);
});

test("the run cap bounds every check of one run together, not each check", () =>
  cleared(async () => {
    const home = temp();
    const options = {
      env: syntheticEnv(home),
      ledgerDir: join(home, "ledger"),
      shareUsd: 10,
      providers: { scripted: { limit: { kind: "key-budget", usd: 10 } } },
    } as const;
    const check1 = realBudget(options);
    const p1 = check1.provider("scripted", script);
    await check1.caller(p1, COST, "check 1", routes).caller.image("still", "a fox", []);
    assert.ok(Math.abs(check1.runLeftUsd() - (RUN_USD - COST)) < 1e-9);

    // A second check of the same run sees the first check's spend against the one run cap.
    const check2 = realBudget(options);
    const p2 = check2.provider("scripted", script);
    assert.ok(Math.abs(check2.runLeftUsd() - (RUN_USD - COST)) < 1e-9);
    assert.throws(
      () => check2.caller(p2, RUN_USD - COST / 2, "check 2", routes),
      BudgetExceededError,
    );
    assert.equal(scriptedOf(p2).calls.length, 0, "no provider call was made");
    assert.ok(check2.budgetLeftUsd() > RUN_USD, "the budget left alone would have allowed it");
  }));

test("every file under test/real imports test/real/budget.ts", () => {
  const realDir = resolve(import.meta.dirname, "real");
  const budgetPath = join(realDir, "budget.ts");
  const files = (readdirSync(realDir, { recursive: true, encoding: "utf8" }) as string[])
    .map((f) => join(realDir, f))
    .filter((f) => /\.[cm]?[jt]sx?$/.test(f) && f !== budgetPath);
  assert.ok(files.length > 0, "no real checks found");
  const missing = files.filter((file) => {
    const imports = ts
      .preProcessFile(readFileSync(file, "utf8"), true, true)
      .importedFiles.map((i) => i.fileName)
      .filter((name) => name.startsWith("."));
    return !imports.some((name) => resolve(dirname(file), name) === budgetPath);
  });
  assert.deepEqual(missing, [], "files that do not import test/real/budget.ts");
});
