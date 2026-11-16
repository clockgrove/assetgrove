/**
 * The set-level audit's real check (test/real/audit.real.ts) runs its set-up through the audit's
 * plan step offline (issue #343): the same set, bible and settings, a dry run with no key and no
 * provider call, so a set-up the audit refuses fails here and not only in a paid run.
 */
import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auditCommand } from "../src/commands/audit.ts";
import { runCommand } from "../src/commands/runner.ts";
import { auditSet } from "./fixtures/audit-set.ts";
import { WORK_ITEM, realBudget } from "./real/budget.ts";

test("the real audit check's set-up passes the audit's plan step offline", async () => {
  const work = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-audit-real-setup-")));
  const lib = auditSet();
  try {
    const env = { ...process.env };
    delete env["AI_GATEWAY_API_KEY"];
    const rb = realBudget({ env, ledgerDir: join(work, "ledger") });
    const lines: string[] = [];
    const ctx = { settings: rb.settings, env: rb.env, log: (line: string) => lines.push(line) };
    const plan = await runCommand(
      auditCommand,
      {
        set: lib.set,
        target: lib.dir,
        runs: join(work, "runs"),
        workItem: WORK_ITEM,
        cap: rb.runLeftUsd(),
        dryRun: true,
      },
      ctx,
    );
    assert.equal(plan.exitCode, 0, JSON.stringify(plan.error) + plan.human);
    const forecast = plan.fields["forecastUsd"];
    assert.ok(typeof forecast === "number" && forecast > 0, `forecast ${String(forecast)}`);
    assert.equal(rb.budgetLeftUsd(), rb.shareUsd, "the plan step spends nothing");
  } finally {
    await rm(lib.dir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});
