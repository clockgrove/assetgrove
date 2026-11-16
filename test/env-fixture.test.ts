import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { refusedVariables } from "../src/env.ts";
import { loadSettings } from "../src/settings.ts";
import {
  HEADLESS_OPERATOR,
  approveCommand,
  declareLimit,
  settingsPath,
  stateDir,
  useAttended,
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
  useAttended();
  approveCommand({ hash: "ab12", kind: "validator", argv: ["node", "v.js"] });
  declareLimit("gateway", { kind: "prepaid", usd: 5 });
  await t.test("a subtest sees the parent's settings", () => {
    assert.equal(onDisk()["headless"], undefined);
  });
  assert.equal(onDisk()["headless"], undefined);
  assert.ok(onDisk()["commands"]);
  assert.ok(onDisk()["providers"]);
});

test("the next test starts from the base settings", () => {
  assert.deepEqual(onDisk(), {
    format: "assetgrove-settings/2",
    stateDir,
    headless: { operator: HEADLESS_OPERATOR },
    providers: { scripted: { limit: { kind: "prepaid", usd: 100 } } },
  });
});
