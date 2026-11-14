import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { refusedVariables } from "../src/env.ts";
import { loadSettings } from "../src/settings.ts";
import {
  approveCommand,
  declareLimit,
  ledgerPath,
  SCRIPTED_LIMIT,
  settingsPath,
  stateDir,
  useHeadless,
} from "./fixtures/env.ts";

const onDisk = () => JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;

test("the fixture's settings name a fresh stateDir beside them and no refused variable is set", () => {
  assert.equal(process.env["ASSETGROVE_CONFIG"], settingsPath);
  assert.equal(dirname(stateDir), dirname(dirname(settingsPath)));
  const settings = loadSettings({ cwd: dirname(settingsPath) });
  assert.equal(settings.stateDir, stateDir);
  assert.deepEqual(refusedVariables(), []);
});

test("a helper's change lasts for its own test, including its subtests", async (t) => {
  useHeadless();
  approveCommand({ hash: "ab12", kind: "validator", argv: ["node", "v.js"] });
  declareLimit("gateway", { kind: "prepaid", usd: 5 });
  await t.test("a subtest sees the parent's settings", () => {
    assert.ok(onDisk()["headless"]);
  });
  assert.ok(onDisk()["headless"]);
  assert.ok(onDisk()["commands"]);
  assert.ok(onDisk()["providers"]);
});

test("the next test starts from the base settings: a declared limit for the scripted provider", () => {
  assert.deepEqual(onDisk(), {
    format: "assetgrove-settings/1",
    stateDir,
    providers: { scripted: { limit: SCRIPTED_LIMIT } },
  });
});

test("the fixture sets no spend variable; the ledger is in the fixture's stateDir", () => {
  assert.equal(process.env["ASSETGROVE_SPEND_LEDGER"], undefined);
  assert.equal(process.env["ASSETGROVE_WORK_ITEM"], undefined);
  assert.equal(ledgerPath, join(stateDir, "spend.jsonl"));
});
