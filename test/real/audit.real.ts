/**
 * Real check of one set-level audit (issue #243): a three-asset synthetic set with an identity
 * lock, audited through the product (`runCommand`, its plan step, confirmation, executor and
 * journal) on the gateway's default routes, under the shared budget of test/real/budget.ts. Before
 * the run the check forecasts the audit's spend from its free plan step and refuses when it does not
 * fit what is left. Skips without AI_GATEWAY_API_KEY.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BIBLE_PRESETS, serializeBible } from "../../src/bible.ts";
import { auditCommand } from "../../src/commands/audit.ts";
import { runCommand } from "../../src/commands/runner.ts";
import { encodePng } from "../../src/image/raster.ts";
import { GAME, fixtureLibrary } from "../fixtures/library.ts";
import { drawSubject } from "../fixtures/synthetic.ts";
import { WORK_ITEM, realBudget, skipWithout } from "./budget.ts";

const skip = skipWithout("AI_GATEWAY_API_KEY");

test("real gateway: one audit of a three-asset set", { skip }, async () => {
  const rb = realBudget();
  const lib = fixtureLibrary({ bulk: 3 });
  const runs = await mkdtemp(join(tmpdir(), "assetgrove-real-audit-"));
  try {
    // Images large enough for every vision model; the third one drawn differently.
    for (let i = 0; i < 3; i++)
      writeFileSync(
        join(lib.root, "bulk", `bulk-00${i}.png`),
        encodePng(drawSubject(384, i === 2 ? 3 : 0)),
      );
    const art = join(lib.dir, ".assetgrove", "art-direction");
    writeFileSync(join(art, "pebble.png"), encodePng(drawSubject(384)));
    const bible = structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
    bible.referenceLicense = "NOASSERTION";
    bible.world = "Synthetic";
    bible.identities = {
      pebble: {
        version: "pebble-1",
        approved: true,
        turnaround: "pebble.png",
        signatureFeatures: ["a round body"],
        proportions: "as wide as tall",
        palette: ["#808080"],
      },
    };
    writeFileSync(join(art, "BIBLE.md"), serializeBible(bible, "# Synthetic\n"));

    const ctx = { settings: rb.settings, env: rb.env, log: (line: string) => console.log(line) };
    const args = {
      set: `asset://${GAME}/by-tag/bulk/`,
      target: lib.dir,
      runs,
      workItem: WORK_ITEM,
      cap: rb.runLeftUsd(),
    };
    const plan = await runCommand(auditCommand, { ...args, dryRun: true }, ctx);
    assert.equal(plan.exitCode, 0, JSON.stringify(plan.error));
    const forecast = plan.fields["forecastUsd"] as number;
    // Refuses (exit-3 family) before any call when the forecast does not fit what is left.
    rb.begin(forecast, "real audit");

    const outcome = await runCommand(auditCommand, args, ctx);
    assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.error) + outcome.human);
    const audit = JSON.parse(
      await readFile(join(outcome.fields["runDir"] as string, "audit.json"), "utf8"),
    ) as {
      members: { style?: { score?: number; advisory: boolean }; identity?: { score?: number } }[];
      spread: { style?: { n: number; stdDev: number; range: number } };
      judgement: { style?: { judged: boolean } };
    };
    assert.equal(audit.members.length, 3);
    for (const m of audit.members) {
      assert.ok(typeof m.style?.score === "number" && m.style.score >= 0 && m.style.score <= 1);
      assert.equal(m.style.advisory, true);
      assert.ok(typeof m.identity?.score === "number");
    }
    assert.equal(audit.spread.style?.n, 3);
    assert.equal(audit.judgement.style?.judged, false, "three assets are under the bar's set size");
    console.log(
      `audit spent $${String(outcome.fields["spentUsd"])}; budget left: $${rb.budgetLeftUsd().toFixed(4)}`,
    );
  } finally {
    await rm(lib.dir, { recursive: true, force: true });
    await rm(runs, { recursive: true, force: true });
  }
});
